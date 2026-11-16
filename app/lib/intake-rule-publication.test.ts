import {describe,expect,it} from 'vitest';
import {validateIntakeRuleFieldReachability} from './workflow-publication-validation';
const steps=[{id:'intake',step_key:'order_creation',name:'录单',sort_order:20,is_active:1},{id:'later',step_key:'warehouse_receiving',name:'收货',sort_order:50,is_active:1}];
const modules=[{id:'module',step_id:'intake',module_code:'consignment',display_name:'委托',is_active:1,is_required:1,responsibility_position_code:'SALES',completion_mode:'all_tasks' as const}];
const field={step_id:'intake',module_code:'consignment',field_key:'quotation_intake_businessMajor',is_active:1,is_required:1,handler_position_codes:'SALES'};
describe('intake rule publication reachability',()=>{
  it('accepts the default intake editor and does not require duplicating built-in controls as overrides',()=>{expect(validateIntakeRuleFieldReachability({steps,modules,fields:[field]})).toEqual([]);expect(validateIntakeRuleFieldReachability({steps,modules,fields:[]})).toEqual([]);});
  it('rejects hidden mandatory data even if someone marks the workflow override optional',()=>expect(validateIntakeRuleFieldReachability({steps,modules,fields:[{...field,is_active:0,is_required:0}]}).join()).toContain('不能隐藏'));
  it('rejects a mandatory fact placed only after intake',()=>expect(validateIntakeRuleFieldReachability({steps,modules,fields:[{...field,step_id:'later'}]}).join()).toContain('不能只放在后续节点'));
  it('rejects disabled owners and unassigned edit positions without changing unrelated late actual data',()=>{
    expect(validateIntakeRuleFieldReachability({steps,modules:[{...modules[0],is_active:0}],fields:[{...field,handler_position_codes:''}]})).toHaveLength(2);
    expect(validateIntakeRuleFieldReachability({steps,modules:[],fields:[{...field,step_id:'later',field_key:'actual_weight_kg'}]})).toEqual([]);
  });
});
