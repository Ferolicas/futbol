import http from 'k6/http';
import { check, sleep } from 'k6';

const baseUrl = String(__ENV.K6_BASE_URL || '').replace(/\/$/, '');
const vus = Number(__ENV.K6_VUS || 3);
const duration = String(__ENV.K6_DURATION || '20s');

if (baseUrl !== 'http://127.0.0.1:3100') {
  throw new Error('Load tests may target only the private staging tunnel on 127.0.0.1:3100');
}
if (!Number.isInteger(vus) || vus < 1 || vus > 10) {
  throw new Error('K6_VUS must be an integer between 1 and 10');
}
if (!/^(?:[1-5]?\d|60)s$/.test(duration)) {
  throw new Error('K6_DURATION must be between 1s and 60s');
}

export const options = {
  vus,
  duration,
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1200', 'p(99)<2500'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const health = http.get(`${baseUrl}/api/health`, {
    tags: { endpoint: 'health' },
    timeout: '5s',
  });
  check(health, {
    'health returns 200': response => response.status === 200,
    'health reports ok': response => response.json('status') === 'ok',
  });

  const home = http.get(`${baseUrl}/`, {
    tags: { endpoint: 'home' },
    timeout: '10s',
  });
  check(home, {
    'home returns 200': response => response.status === 200,
    'security header is present': response => response.headers['X-Content-Type-Options'] === 'nosniff',
  });
  sleep(1);
}
