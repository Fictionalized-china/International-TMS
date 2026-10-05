import { useEffect, useRef, useState, type ReactNode, type Dispatch, type SetStateAction } from 'react';
import { feeLineAmount, MAX_INTAKE_FEE_LINES, newFeeDraft, type FeeDraft } from '../lib/intake-fee-lines';

export const intakeStepNames = ['客户与方案', '路线与货物', '数量与尺寸', '客户应收', '开单应付'];
type Validatable = HTMLElement & Pick<HTMLInputElement, 'form' | 'willValidate' | 'validity' | 'checkValidity' | 'reportValidity'>;
export function firstInvalidIntakeControl(root: HTMLElement, throughStep: number): Validatable | undefined {
  return [...root.querySelectorAll<Validatable>('input,select,textarea')].find(control => {
    const step = control.closest<HTMLElement>('[data-intake-step]')?.dataset.intakeStep;
    return step !== undefined && Number(step) <= throughStep && control.form === root.closest('form') && control.willValidate && !control.validity.valid;
  });
}
/** Keep every panel mounted: hidden does not mean disabled, and FormData still contains all steps. */
export function IntakeStepLayout({ enabled, busy, children }: { enabled: boolean; busy: boolean; children: ReactNode }) {
  const [step, setStep] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const validate = (throughStep: number) => {
    const invalid = root.current && firstInvalidIntakeControl(root.current, throughStep);
    if (!invalid) return true;
    const panel = invalid.closest<HTMLElement>('[data-intake-step]');
    setStep(Number(panel?.dataset.intakeStep || 0));
    // Notify a paginated fee editor before asking the browser to focus/report the invalid input.
    invalid.checkValidity();
    requestAnimationFrame(() => { invalid.focus(); invalid.reportValidity(); });
    return false;
  };
  const move = (target: number) => {
    if (busy) return;
    if (target > step && !validate(target - 1)) return;
    setStep(target);
    if (root.current) root.current.querySelector('.intake-step-content')?.scrollTo(0, 0);
  };
  useEffect(() => {
    if (!enabled) return;
    const form = root.current?.closest('form');
    if (!form) return;
    const onSubmit = (event: Event) => {
      if (event.target !== form) return; // A nested customer editor is a separate action.
      if (busy) { event.preventDefault(); return; }
      if (step < intakeStepNames.length - 1) { event.preventDefault(); move(step + 1); }
      else if (!validate(step)) event.preventDefault();
    };
    form.addEventListener('submit', onSubmit, true);
    return () => form.removeEventListener('submit', onSubmit, true);
  }, [enabled, step, busy]);
  return <div ref={root} className={enabled ? 'intake-step-layout' : undefined}
    data-active-step={enabled ? step : undefined}>
    {enabled && <nav className="intake-step-nav" aria-label="录单步骤">{intakeStepNames.map((name, index) =>
      <button key={name} type="button" disabled={busy} aria-current={index === step ? 'step' : undefined}
        onClick={() => move(index)}><span>{index + 1}</span>{name}</button>)}</nav>}
    <div className={enabled ? 'intake-step-content' : undefined}>{children}</div>
    <div className={enabled ? 'intake-step-actions' : 'modal-form-actions'}>
      {enabled && <><span aria-live="polite">第 {step + 1} / {intakeStepNames.length} 步 · 切换步骤保留填写内容</span>
        <button className="btn" type="button" disabled={busy || step === 0} onClick={() => move(step - 1)}>上一步</button></>}
      {enabled && step < intakeStepNames.length - 1
        ? <button key="next-step" className="btn primary" type="button" disabled={busy} onClick={event => { event.preventDefault(); move(step + 1); }}>下一步 →</button>
        : <button key="submit-entry" className="btn primary" type="submit" disabled={busy}>{busy ? '正在保存…' : enabled ? '确认资料并建立订单' : '保存报价并等待客户确认'}</button>}
    </div>
  </div>;
}

const PAGE_SIZE = 5;
export function IntakeFeeEditor({ direction, rows, setRows, options, required = false, recommended = [] }: {
  direction: 'receivable' | 'payable'; rows: FeeDraft[]; setRows: Dispatch<SetStateAction<FeeDraft[]>>;
  options: readonly { code: string; label: string }[]; required?: boolean;
  recommended?: readonly { code: string; label: string }[];
}) {
  const [requestedPage, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount - 1);
  const payable = direction === 'payable';
  const names = payable
    ? ['intakePayableCode','intakePayableQuantity','intakePayableUnitPrice','intakePayableNotes']
    : ['chargeName','chargeQuantity','chargeUnitPrice','chargeNotes'];
  const total = rows.reduce((sum, row) => sum + (Number.isFinite(feeLineAmount(Number(row.quantity),Number(row.unitPrice)))
    ? feeLineAmount(Number(row.quantity),Number(row.unitPrice)) : 0), 0);
  const update = (id: string, patch: Partial<FeeDraft>) => setRows(current => current.map(row => row.id === id ? {...row,...patch} : row));
  const add = (code: string) => {
    if (rows.length >= MAX_INTAKE_FEE_LINES) return;
    setRows(current => [...current,newFeeDraft(code)]); setPage(Math.floor(rows.length / PAGE_SIZE));
  };
  return <div className="intake-fee-editor" onInvalidCapture={event => {
    const index = (event.target as HTMLElement).closest<HTMLElement>('[data-fee-index]')?.dataset.feeIndex;
    if (index !== undefined) setPage(Math.floor(Number(index) / PAGE_SIZE));
  }}>
    <div className="intake-fee-toolbar"><p>同一费用可登记多条。填写数量和单价，系统计算金额；{payable ? '每条可选择不同往来单位。' : '无需人工合计。'}</p>
      <button type="button" className="btn primary" disabled={rows.length >= MAX_INTAKE_FEE_LINES} onClick={() => add(options[0]?.code || '')}>＋ 新增费用明细</button></div>
    {recommended.length > 0 && <div className="intake-fee-shortcuts"><span>本类型费用快捷新增（必录方向按策略）：</span>{recommended.map(fee =>
      <button key={fee.code} type="button" className="btn" disabled={rows.length >= MAX_INTAKE_FEE_LINES} onClick={() => add(fee.code)}>＋ {fee.label}</button>)}</div>}
    <div className="table-wrap"><table className="inline-table intake-fee-table"><thead><tr>
      <th scope="col">费用类别</th><th scope="col">数量</th><th scope="col">单价 CNY</th><th scope="col">金额 CNY</th>
      {payable && <th scope="col">应付往来单位</th>}<th scope="col">备注 / 说明</th><th scope="col">操作</th>
    </tr></thead><tbody>{rows.map((row,index) => <tr key={row.id} data-fee-index={index} hidden={Math.floor(index / PAGE_SIZE) !== page}>
      <td><select aria-label={`第${index+1}条费用类别`} className="control" name={names[0]} value={row.code} onChange={e => update(row.id,{code:e.target.value})} required>
        {options.map(option => <option key={option.code} value={option.code}>{option.label}</option>)}</select></td>
      <td><input aria-label={`第${index+1}条费用数量`} className="control" name={names[1]} type="number" min="0.01" step="0.01" value={row.quantity} required={required || Boolean(row.unitPrice || row.counterparty || row.notes)} onChange={e => update(row.id,{quantity:e.target.value})}/></td>
      <td><input aria-label={`第${index+1}条费用单价`} className="control" name={names[2]} type="number" min="0" step="0.01" value={row.unitPrice} required={required || Boolean(row.counterparty || row.notes || row.quantity !== '1')} onChange={e => update(row.id,{unitPrice:e.target.value})}/></td>
      <td><output>{row.unitPrice.trim() && row.quantity.trim() && Number.isFinite(feeLineAmount(Number(row.quantity),Number(row.unitPrice))) ? feeLineAmount(Number(row.quantity),Number(row.unitPrice)).toFixed(2) : '—'}</output></td>
      {payable && <td><input aria-label={`第${index+1}条费用往来单位`} className="control" name="intakePayableCounterparty" value={row.counterparty} maxLength={200} required={Boolean(row.unitPrice)} onChange={e => update(row.id,{counterparty:e.target.value})} placeholder="如供应商或客户自送"/></td>}
      <td><input aria-label={`第${index+1}条费用备注`} className="control" name={names[3]} value={row.notes} maxLength={1000} onChange={e => update(row.id,{notes:e.target.value})}/></td>
      <td><div className="intake-fee-row-actions"><button className="btn" type="button" aria-label={`新增第${index+1}条同类费用`} disabled={rows.length >= MAX_INTAKE_FEE_LINES} onClick={() => add(row.code)}>＋ 同类</button><button className="btn danger" type="button" aria-label={`删除第${index+1}条费用`} onClick={() => setRows(current => current.filter(item => item.id !== row.id))}>删除</button></div></td>
    </tr>)}{!rows.length && <tr><td colSpan={payable ? 7 : 6}>尚未登记，点击“新增费用明细”。明确免费请填写单价 0，不要用空白代替。</td></tr>}</tbody></table></div>
    <div className="intake-fee-summary"><span>共 {rows.length} 条 · 第 {page + 1} / {pageCount} 页（每页 {PAGE_SIZE} 条）</span>
      <button type="button" className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
      <button type="button" className="btn" disabled={page === pageCount - 1} onClick={() => setPage(page + 1)}>下一页</button>
      <strong>{payable ? '应付' : '应收'}合计 CNY {total.toFixed(2)}</strong></div>
    {rows.length >= MAX_INTAKE_FEE_LINES && <p role="status">单次录单最多 {MAX_INTAKE_FEE_LINES} 条，后续费用可在订单费用台账中继续新增。</p>}
  </div>;
}
