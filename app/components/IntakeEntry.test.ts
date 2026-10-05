import { describe,it,expect,vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import { IntakeStepLayout,IntakeFeeEditor } from './IntakeEntry';
import { newFeeDraft } from '../lib/intake-fee-lines';
describe('intake step and fee presentation',()=>{
  it('mounts every step without disabling hidden values, but only offers Next before confirmation',()=>{
    const html=renderToStaticMarkup(h(IntakeStepLayout,{enabled:true,busy:false,children:[
      h('section',{'data-intake-step':'0',key:0},h('input',{name:'first',defaultValue:'甲'})),
      h('section',{'data-intake-step':'4',key:4},h('input',{name:'last',defaultValue:'乙',required:true})),
    ]}));
    expect(html).toContain('data-active-step="0"');expect(html).toContain('name="last"');
    expect(html).toContain('下一步');expect(html).not.toContain('确认资料并建立订单');
    expect(html.match(/<input[^>]*>/g)?.every(input=>!input.includes('disabled'))).toBe(true);
  });
  it('leaves the optional quotation flow as a normal form',()=>{
    const html=renderToStaticMarkup(h(IntakeStepLayout,{enabled:false,busy:false,children:h('input',{name:'quote'})}));
    expect(html).not.toContain('aria-label="录单步骤"');expect(html).toContain('保存报价并等待客户确认');
  });
  it('keeps paginated same-category rows in the submitted DOM and calculates each amount',()=>{
    const rows=Array.from({length:6},()=>({...newFeeDraft('packing'),quantity:'3',unitPrice:'12.35',counterparty:'供应商'}));
    const html=renderToStaticMarkup(h(IntakeFeeEditor,{direction:'payable',rows,setRows:vi.fn(),options:[{code:'packing',label:'包装费'}]}));
    expect(html.match(/name="intakePayableCode"/g)).toHaveLength(6);
    expect(html).toContain('data-fee-index="5" hidden');expect(html).toContain('222.30');
    expect(html.match(/37.05/g)).toHaveLength(6);expect(html).toContain('新增费用明细');
  });
});
