const BASE_URL = 'https://sports.bzzoiro.com/api';

async function bzzoiroCall(endpoint, apiKey) {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { Authorization: `Token ${apiKey}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Bzzoiro API error: ${res.status}`);
  return res.json();
}

// Get live scores for all active matches
export async function getBzzoiroLive(apiKey) {
  const data = await bzzoiroCall('/live/', apiKey);
  return data.results || [];
}

// Get events (fixtures) for a date, optionally filtered by status
export async function getBzzoiroEvents(date, apiKey, status) {
  let endpoint = `/events/?event_date=${date}`;
  if (status) endpoint += `&status=${status}`;
  const data = await bzzoiroCall(endpoint, apiKey);
  return data.results || [];
}

// Get ML predictions for upcoming matches
export async function getBzzoiroPredictions(apiKey, upcoming = true) {
  let endpoint = '/predictions/';
  if (upcoming) endpoint += '?upcoming=true';
  const data = await bzzoiroCall(endpoint, apiKey);
  return data.results || [];
}

// Normalize team name for matching between APIs
function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove accents
    .replace(/[^a-z0-9\s]/g, '') // remove special chars
    .replace(/\s+/g, ' ')
    .trim();
}

// Match Bzzoiro live data to API-Football fixtures by team names + date
export function matchBzzoiroToFixtures(bzzoiroMatches, fixtures) {
  const updates = {};

  for (const bm of bzzoiroMatches) {
    const bHome = normalizeName(bm.home_team);
    const bAway = normalizeName(bm.away_team);

    let bestMatch = null;
    let bestScore = 0;

    for (const fix of fixtures) {
      const fHome = normalizeName(fix.teams?.home?.name);
      const fAway = normalizeName(fix.teams?.away?.name);

      // Try exact match first
      if (bHome === fHome && bAway === fAway) {
        bestMatch = fix;
        bestScore = 100;
        break;
      }

      // Partial match (one name contains the other)
      let score = 0;
      if (bHome.includes(fHome) || fHome.includes(bHome)) score += 50;
      if (bAway.includes(fAway) || fAway.includes(bAway)) score += 50;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = fix;
      }
    }

    if (bestMatch && bestScore >= 80) {
      updates[bestMatch.fixture.id] = {
        homeScore: bm.home_score ?? bm.score_home ?? null,
        awayScore: bm.away_score ?? bm.score_away ?? null,
        status: bm.status || bm.match_status || null,
        elapsed: bm.current_minute || bm.elapsed || bm.minute || null,
        bzzoiroId: bm.id,
      };
    }
  }

  return updates;
}

// Apply Bzzoiro live updates to fixture array
export function applyLiveUpdates(fixtures, updates) {
  return fixtures.map(fix => {
    const update = updates[fix.fixture.id];
    if (!update) return fix;

    const elapsed = update.elapsed || fix.fixture.status.elapsed || 0;
    const statusMap = {
      '1st_half': '1H',
      '1st half': '1H',
      '2nd_half': '2H',
      '2nd half': '2H',
      inprogress: elapsed <= 45 ? '1H' : '2H',
      'in progress': elapsed <= 45 ? '1H' : '2H',
      in_progress: elapsed <= 45 ? '1H' : '2H',
      live: elapsed <= 45 ? '1H' : '2H',
      '1h': '1H',
      '2h': '2H',
      halftime: 'HT',
      'half time': 'HT',
      half_time: 'HT',
      ht: 'HT',
      finished: 'FT',
      ft: 'FT',
      ended: 'FT',
      notstarted: 'NS',
      not_started: 'NS',
      'not started': 'NS',
      ns: 'NS',
      scheduled: 'NS',
      cancelled: 'CANC',
      canceled: 'CANC',
      postponed: 'PST',
      suspended: 'SUSP',
      extra_time: 'ET',
      extratime: 'ET',
      penalties: 'P',
      penalty: 'P',
      after_extra_time: 'AET',
      after_penalties: 'PEN',
    };

    const rawStatus = (update.status || '').toLowerCase().trim();
    const mappedStatus = statusMap[rawStatus] || fix.fixture.status.short;

    return {
      ...fix,
      goals: {
        home: update.homeScore !== null ? update.homeScore : fix.goals.home,
        away: update.awayScore !== null ? update.awayScore : fix.goals.away,
      },
      fixture: {
        ...fix.fixture,
        status: {
          ...fix.fixture.status,
          short: mappedStatus,
          elapsed: update.elapsed || fix.fixture.status.elapsed,
        },
      },
      _liveSource: 'bzzoiro',
    };
  });
}
