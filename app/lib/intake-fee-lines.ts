import { transportChargeNameOptions } from './charge-options';
import { configuredOrderIntakeFees, ftlOrderIntakeFeeRequirements } from './order-intake-fees';
import type { BusinessProcessPolicy } from './business-process-policy';

export const MAX_INTAKE_FEE_LINES = 100;
export type IntakePayable = {
  chargeCode: string; chargeName: string; amount: number; counterparty: string;
  quantity?: number; unitPrice?: number; notes?: string | null;
};
export type FeeDraft = {
  id: string; code: string; quantity: string; unitPrice: string; counterparty: string; notes: string;
};
export function newFeeDraft(code: string): FeeDraft {
  return { id: crypto.randomUUID(), code, quantity: '1', unitPrice: '', counterparty: '', notes: '' };
}
/** Monetary amounts are rounded per line, before summation, on both client and server. */
export function feeLineAmount(quantity: number, unitPrice: number): number {
  const amount = quantity * unitPrice;
  return Math.round((amount + Number.EPSILON * Math.abs(amount)) * 100) / 100;
}
export function intakePayableOptions(policy: BusinessProcessPolicy, businessType: 'ltl' | 'ftl') {
  // Stable codes, never array-index identifiers: inserting a category must not rename historical costs.
  const extras = transportChargeNameOptions.map(([label]) => ({ code: `detail:${label}`, label }));
  return [...new Map([...ftlOrderIntakeFeeRequirements, ...extras,
    ...configuredOrderIntakeFees(policy, businessType)].map(fee => [fee.code, { code: fee.code, label: fee.label }])).values()]
    .filter((fee, index, all) => all.findIndex(item => item.label === fee.label) === index);
}

export function parseIntakePayables(form: FormData, options: readonly { code: string; label: string }[]): IntakePayable[] {
  const codes = form.getAll('intakePayableCode').map(String);
  if (codes.length > MAX_INTAKE_FEE_LINES) throw new Error(`开单应付费用最多 ${MAX_INTAKE_FEE_LINES} 条`);
  const detailed = form.has('intakePayableUnitPrice');
  const prices = form.getAll(detailed ? 'intakePayableUnitPrice' : 'intakePayableAmount').map(String);
  const quantities = form.getAll('intakePayableQuantity').map(String);
  const parties = form.getAll('intakePayableCounterparty').map(String);
  const notes = form.getAll('intakePayableNotes').map(String);
  if (prices.length !== codes.length || (detailed &&
    (quantities.length !== codes.length || parties.length !== codes.length || notes.length !== codes.length))) {
    throw new Error('费用明细不完整，请刷新后重新填写');
  }
  return codes.flatMap((code, index) => {
    const fee = options.find(item => item.code === code);
    if (!fee) throw new Error('开单费用配置已变化，请刷新后重新填写');
    const rawPrice = prices[index].trim();
    const counterparty = (detailed ? parties[index] : parties[0] || '').trim();
    const note = (notes[index] || '').trim();
    const rawQuantity = detailed ? quantities[index].trim() : '1';
    // Untouched optional rows are blank, never implicitly zero. Partial details must not disappear.
    if (!rawPrice && (!detailed || (!counterparty && !note && rawQuantity === '1'))) return [];
    const quantity = Number(rawQuantity), unitPrice = Number(rawPrice);
    const amount = feeLineAmount(quantity, unitPrice);
    if (!rawPrice || !rawQuantity || !Number.isFinite(quantity) || quantity <= 0 ||
      !Number.isFinite(unitPrice) || unitPrice < 0 || !Number.isFinite(amount) || amount > Number.MAX_SAFE_INTEGER / 100) {
      throw new Error(`第 ${index + 1} 条${fee.label}的数量或单价无效`);
    }
    if (!counterparty) throw new Error(`请填写第 ${index + 1} 条${fee.label}的应付往来单位`);
    if (counterparty.length > 200 || note.length > 1000) throw new Error(`第 ${index + 1} 条费用的往来单位或备注过长`);
    return [{ chargeCode: code, chargeName: fee.label, quantity, unitPrice, amount, counterparty, notes: note || null }];
  });
}
