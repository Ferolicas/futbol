import importlib.util, tempfile, unittest, tarfile
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('backup','scripts/vps/holding_daily_backup.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Retention(unittest.TestCase):
 def test_keep_previous_valid_day_and_remove_failed_attempts(self):
  with tempfile.TemporaryDirectory() as d:
   with patch.object(m,'ROOT',Path(d)):
    for day in ['2026-09-16','2026-09-17','2026-09-19']:
     p=Path(d)/day;p.mkdir();(p/'COMPLETE.json').write_text('{}')
    p=Path(d)/'2026-09-18';p.mkdir();(p/'db.partial').write_text('interrupted')
    m.prune_sets('2026-09-19')
    self.assertFalse((Path(d)/'2026-09-16').exists())
    self.assertTrue((Path(d)/'2026-09-17').exists())
    self.assertFalse((Path(d)/'2026-09-18').exists())
    self.assertTrue((Path(d)/'2026-09-19').exists())
 def test_same_day_does_not_dump_again(self):
  with tempfile.TemporaryDirectory() as d:
   today=m.dt.date.today().isoformat();p=Path(d)/today;p.mkdir();(p/'COMPLETE.json').write_text('{}')
   with patch.object(m,'ROOT',Path(d)), patch.object(m,'run',side_effect=AssertionError('must not dump')):
    m.backup()
 def test_failed_current_backup_cannot_prune_previous_copies(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'2026-09-18';p.mkdir();(p/'COMPLETE.json').write_text('{}')
   with patch.object(m,'ROOT',Path(d)):
    with self.assertRaises(RuntimeError):m.prune_sets('2026-09-19')
   self.assertTrue(p.exists())
 def test_app_archive_preserves_assets_and_env_without_rebuildable_dependencies(self):
  with tempfile.TemporaryDirectory() as d:
   source=Path(d)/'app';source.mkdir()
   (source/'.env').write_text('EXAMPLE=fixture-only')
   (source/'asset.txt').write_text('uploaded asset')
   (source/'node_modules').mkdir();(source/'node_modules/pkg').write_text('rebuildable')
   target=Path(d)/'apps.tar.gz'
   m.archive(target,[str(source)],['node_modules'])
   with tarfile.open(target) as archive:
    names=archive.getnames()
    self.assertTrue(any(n.endswith('/.env') for n in names))
    self.assertTrue(any(n.endswith('/asset.txt') for n in names))
    self.assertFalse(any('node_modules' in n for n in names))
unittest.main()
