import { describe, expect, it } from 'vitest';
import { defaultBusinessProcessPolicy } from './business-process-policy';
import { feeLineAmount, intakePayableOptions, parseIntakePayables } from './intake-fee-lines';
import { missingOrderIntakeFees } from './order-intake-fees';
const options = intakePayableOptions(defaultBusinessProcessPolicy, 'ftl');
function detail(rows: { code?: string; qty?: string; price?: string; party?: string; note?: string }[]) {
  const form = new FormData();
  for (const row of rows) {
    form.append('intakePayableCode', row.code ?? 'pickup');
    form.append('intakePayableQuantity', row.qty ?? '1');
    form.append('intakePayableUnitPrice', row.price ?? '');
    form.append('intakePayableCounterparty', row.party ?? '');
    form.append('intakePayableNotes', row.note ?? '');
  }
  return form;
}
describe('intake fee details', () => {
  it('retains repeated categories, suppliers and quantities without trusting submitted totals', () => {
    const form = detail([{ qty:'3', price:'12.35', party:'供应商甲', note:'第一次' }, { qty:'2', price:'20', party:'供应商乙' }]);
    form.append('intakePayableAmount','9999');
    const rows = parseIntakePayables(form, options);
    expect(rows.map(r => r.amount)).toEqual([37.05,40]);
    expect(rows.map(r => r.counterparty)).toEqual(['供应商甲','供应商乙']);
    expect(rows[0]).toMatchObject({quantity:3,unitPrice:12.35,notes:'第一次'});
  });
  it('keeps explicit zero and ignores untouched blank optional lines', () => {
    const rows = parseIntakePayables(detail([{price:'0',party:'客户自送'},{}]), options);
    expect(rows).toHaveLength(1); expect(rows[0].amount).toBe(0);
    expect(missingOrderIntakeFees('ltl',rows)).toEqual([]);
  });
  it('supports the previous intake form, including blank fees', () => {
    const form = new FormData(); form.append('intakePayableCounterparty','旧往来单位');
    for (const [code,amount] of [['pickup','0'],['handling','']]) {
      form.append('intakePayableCode',code); form.append('intakePayableAmount',amount);
    }
    expect(parseIntakePayables(form,options)).toMatchObject([{chargeCode:'pickup',amount:0,quantity:1,counterparty:'旧往来单位'}]);
  });
  it.each([{qty:'0',price:'2'}, {qty:'',price:'2'}, {price:'-1'}, {price:'Infinity'}, {price:'1',party:''}, {party:'只填了往来单位'}, {qty:'2'}])('rejects invalid and partial lines: %o', row => {
    expect(()=>parseIntakePayables(detail([{party:'供应商',...row}]),options)).toThrow();
  });
  it('rejects mismatched arrays, unknown codes and excessive rows', () => {
    const form=detail([{price:'1',party:'供应商'}]); form.delete('intakePayableQuantity');
    expect(()=>parseIntakePayables(form,options)).toThrow('不完整');
    expect(()=>parseIntakePayables(detail([{code:'injected'}]),options)).toThrow('配置');
    expect(()=>parseIntakePayables(detail(Array.from({length:101},()=>({}))),options)).toThrow('最多');
  });
  it('supports configured custom categories without dropping mandatory FTL gates', () => {
    const custom=intakePayableOptions({...defaultBusinessProcessPolicy,'order.ltl_required_fees':'pickup,inspection'},'ltl');
    expect(custom).toContainEqual({code:'inspection',label:'inspection'});
    expect(options.some(o=>o.label==='包装费')).toBe(true);
    expect(options.some(o=>o.label==='打包费')).toBe(true);
    expect(missingOrderIntakeFees('ftl',parseIntakePayables(detail([{price:'0',party:'自送'}]),options))).toHaveLength(5);
  });
  it('rounds each line consistently, then sums rounded amounts', () => {
    expect(feeLineAmount(3,0.1)).toBe(0.3);
    expect(feeLineAmount(1.005,1)).toBe(1.01);
    expect(feeLineAmount(0.01,0.01)).toBe(0);
  });
});
