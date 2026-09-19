#!/usr/bin/env python3
"""One verified daily backup set for the holding; retain today and yesterday.
Private local sets include every PostgreSQL database, Redis, apps and config.
No full-VPS backup is made as a side effect of an application change.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess as sp

ROOT = Path('/var/backups/holding')
PG = '/usr/lib/postgresql/17/bin/'

def run(args, **kw):
    return sp.run(args, check=True, **kw)

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(4 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def complete(path):
    return (path / 'COMPLETE.json').is_file()

def prune_sets(today):
    # Keep the previous good backup on a failed/missed day, never zero redundancy.
    previous = sorted(p for p in ROOT.iterdir() if p.is_dir() and
                      re.fullmatch(r'\d{4}-\d{2}-\d{2}', p.name) and
                      p.name < today and complete(p))
    keep = {today}
    if previous:
        keep.add(previous[-1].name)
    for p in ROOT.iterdir():
        if p.is_dir() and re.fullmatch(r'\d{4}-\d{2}-\d{2}', p.name) and p.name not in keep:
            if complete(p):
                print('Pruning verified expired set:', p, flush=True)
                shutil.rmtree(p)

def archive(target, roots, excludes=()):
    tmp = target.with_name(target.name + '.partial')
    args = ['tar', '-czf', str(tmp), '-C', '/']
    args += ['--exclude=' + item for item in excludes]
    args += [str(p).lstrip('/') for p in roots if Path(p).exists()]
    result = sp.run(args)
    # GNU tar 1 means files changed while archiving live apps; archive is readable.
    if result.returncode not in (0, 1):
        raise RuntimeError('App/config archive failed')
    run(['tar', '-tzf', str(tmp)], stdout=sp.DEVNULL)
    tmp.replace(target)

def backup():
    today = dt.date.today().isoformat()
    target = ROOT / today
    if complete(target):
        print('Already complete today; no duplicate backup:', target)
        prune_sets(today)
        return
    # A new set needs working space; never consume the last bytes on production.
    if shutil.disk_usage(ROOT).free < 15 * 1024**3:
        raise RuntimeError('Less than 15 GiB free; backup aborted before writing')
    target.mkdir(mode=0o700, exist_ok=True)
    dbdir = target / 'postgres'
    dbdir.mkdir(mode=0o700, exist_ok=True)
    databases = json.loads(sp.check_output(['sudo', '-u', 'postgres', PG+'psql', '-XAt', '-c',
        "SELECT json_agg(datname ORDER BY datname) FROM pg_database WHERE NOT datistemplate AND datallowconn AND datname <> 'cfanalisis_restore_drill'"]))
    for name in databases:
        if not re.fullmatch(r'[A-Za-z0-9_-]+', name):
            raise RuntimeError('Unexpected database filename')
        out = dbdir / (name + '.dump')
        # Resume only a completed, verifiable component of this same daily set.
        if out.exists():
            run([PG+'pg_restore', '--list', str(out)], stdout=sp.DEVNULL)
            continue
        print('Dump:', name, flush=True)
        tmp = out.with_suffix('.partial')
        with tmp.open('wb') as stream:
            run(['sudo', '-u', 'postgres', PG+'pg_dump', '-Fc', '-Z', '6', '-d', name], stdout=stream)
        run([PG+'pg_restore', '--list', str(tmp)], stdout=sp.DEVNULL)
        tmp.replace(out)
    with (target / 'roles.sql').open('wb') as f:
        run(['sudo', '-u', 'postgres', PG+'pg_dumpall', '--globals-only'], stdout=f)
    redis = target / 'redis.rdb.gz'
    if not redis.exists():
        tmp = target / 'redis.rdb'
        run(['redis-cli', '-h', '127.0.0.1', '--rdb', str(tmp)], stdout=sp.DEVNULL)
        run(['redis-check-rdb', str(tmp)], stdout=sp.DEVNULL)
        run(['gzip', '-f', str(tmp)])
    with (target / 'crontab.txt').open('wb') as f:
        run(['crontab', '-l'], stdout=f)
    with (target / 'pm2.json').open('wb') as f:
        run(['pm2', 'jlist'], stdout=f)
    if not (target / 'apps-config.tar.gz').exists():
        print('Archiving app sources, uploads, envs and system configuration', flush=True)
        archive(target / 'apps-config.tar.gz', [
            '/apps', '/var/www', '/opt/n8n', '/root/.n8n', '/root/.pm2/dump.pm2',
            '/etc/caddy', '/etc/nginx', '/etc/postgresql', '/etc/pgbouncer', '/etc/redis',
            '/etc/cron.d', '/etc/systemd/system', '/usr/local/bin', '/usr/local/sbin',
        ], ['node_modules', '.next', '.git', '.web-releases', '.cache', '*.log',
            'apps/backup', 'apps/futbol-staging/releases', 'var/www/market-unity'])
    if not (target / 'backup-config.tar.gz').exists():
        archive(target / 'backup-config.tar.gz', ['/apps/backup/.env', '/root/.config/rclone', '/root/.gnupg'])
    unity = Path('/var/www/market-unity/current')
    if unity.is_symlink() and not (target / 'unity-current.tar.gz').exists():
        archive(target / 'unity-current.tar.gz', [str(unity.resolve())])
        (target / 'unity-current-path.txt').write_text(str(unity.resolve())+'\n')
    files = {}
    for p in sorted(target.rglob('*')):
        if p.is_file() and p.name != 'COMPLETE.json':
            if p.name.endswith('.partial'):
                raise RuntimeError('Unexpected unfinished component')
            files[str(p.relative_to(target))] = {'bytes': p.stat().st_size, 'sha256': digest(p)}
    manifest = {'date': today, 'databases': databases, 'files': files,
                'apps_recovery': 'Restore sources/assets/envs, install lockfile dependencies and rebuild. Unity active build included.'}
    tmp = target / 'COMPLETE.json.partial'
    tmp.write_text(json.dumps(manifest, indent=2)+'\n')
    tmp.replace(target / 'COMPLETE.json')
    print('COMPLETE:', target, flush=True)
    prune_sets(today)

def prune_releases(apply=False):
    # Only these known immutable release trees, never generic app/data directories.
    if apply and not complete(ROOT / dt.date.today().isoformat()):
        raise RuntimeError("Finish today's app backup before pruning releases")
    processes = json.loads(sp.check_output(['pm2', 'jlist']))
    for root, prefix in [(Path('/apps/futbol/.web-releases'), 'release-'),
                         (Path('/var/www/market-unity/releases'), '')]:
        if not root.exists():
            continue
        releases = [p for p in root.iterdir() if p.is_dir() and not p.is_symlink() and
                    (p.name.startswith(prefix) if prefix else re.fullmatch(r'\d{8}[A-Za-z0-9_-]*', p.name))]
        keep = set()
        pointer = root / 'current' if prefix else root.parent / 'current'
        if pointer.is_symlink():
            keep.add(pointer.resolve())
        elif pointer.is_file():
            keep.add(Path(pointer.read_text().strip()).resolve())
        for process in processes:
            env = process['pm2_env']
            for key in ('pm_exec_path', 'pm_cwd'):
                path = Path(env.get(key) or '/').resolve()
                for release in releases:
                    if path == release or release in path.parents:
                        keep.add(release)
        if not keep or not all(p in releases for p in keep):
            raise RuntimeError('Cannot identify active release safely: '+str(root))
        # Recovery history lives in the two daily app backups; keep only active runtimes.
        print('Preserve:', ', '.join(str(p) for p in sorted(keep)), flush=True)
        for path in sorted(set(releases)-keep):
            # A deployment may be building a candidate not yet pointed to by PM2.
            # Do not prune a directory newer than the active runtime.
            if path.stat().st_mtime >= max(p.stat().st_mtime for p in keep):
                continue
            print('Remove release:', path, flush=True)
            if apply:
                shutil.rmtree(path)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['backup', 'prune-releases'])
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock_path = '/run/lock/holding-daily-backup.lock' if args.action == 'backup' else '/run/lock/holding-release-prune.lock'
    with open(lock_path, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == 'backup':
            backup()
        else:
            prune_releases(args.apply)
