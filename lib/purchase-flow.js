export const PURCHASE_PLAN_IDS = [
  'semanal',
  'mensual',
  'trimestral',
  'semestral',
  'anual',
];

const PURCHASE_PLAN_ID_SET = new Set(PURCHASE_PLAN_IDS);

const PURCHASE_PLAN_LABELS = {
  semanal: 'Semanal',
  mensual: 'Mensual',
  trimestral: 'Trimestral',
  semestral: 'Semestral',
  anual: 'Anual',
};

const PURCHASE_INTENT_PATTERN = /^[A-Za-z0-9_-]{12,80}$/;

export function normalizePurchasePlan(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' && PURCHASE_PLAN_ID_SET.has(candidate)
    ? candidate
    : null;
}

export function normalizePurchaseIntent(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === 'string' && PURCHASE_INTENT_PATTERN.test(candidate)
    ? candidate
    : null;
}

export function createPurchaseIntent() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export function purchasePlanLabel(plan) {
  return PURCHASE_PLAN_LABELS[normalizePurchasePlan(plan)] || null;
}

export function purchaseRoute(pathname, parameter, plan, intent = null) {
  const validPlan = normalizePurchasePlan(plan);
  if (!validPlan) return pathname;
  const params = new URLSearchParams({ [parameter]: validPlan });
  const validIntent = normalizePurchaseIntent(intent);
  if (validIntent) params.set('intent', validIntent);
  return `${pathname}?${params.toString()}`;
}
