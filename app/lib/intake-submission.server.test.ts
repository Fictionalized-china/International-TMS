import { describe,it,expect } from 'vitest';
import { intakeSubmissionIdentity,assertDirectIntakeAuthority } from './intake-submission.server';
import { defaultBusinessProcessPolicy } from './business-process-policy';
describe('direct intake request identity',()=>{
  it('reuses the same actor request and separates organizations and people',async()=>{
    const form=new FormData();form.set('intakeRequestId','request-000000001');form.set('customerId','customer');
    const first=await intakeSubmissionIdentity(form,'org','sales');expect(await intakeSubmissionIdentity(form,'org','sales')).toEqual(first);
    expect((await intakeSubmissionIdentity(form,'other','sales')).id).not.toBe(first.id);
    expect((await intakeSubmissionIdentity(form,'org','other')).id).not.toBe(first.id);
    form.set('amount','20');expect((await intakeSubmissionIdentity(form,'org','sales')).payloadHash).not.toBe(first.payloadHash);
  });
  it('rejects invalid tokens and detects changed file contents',async()=>{
    const form=new FormData();await expect(intakeSubmissionIdentity(form,'org','sales')).rejects.toThrow('请求已失效');
    form.set('intakeRequestId','request-000000001');form.set('attachment',new File(['1'],'proof.txt'));
    const first=await intakeSubmissionIdentity(form,'org','sales');form.set('attachment',new File(['2'],'proof.txt'));
    expect((await intakeSubmissionIdentity(form,'org','sales')).payloadHash).not.toBe(first.payloadHash);
  });
  it('rechecks current intake authority before recovering a not-yet-created order',()=>{
    const input={policy:{...defaultBusinessProcessPolicy},positionCode:'SALES',roleCodes:[],customerCsEnabled:0,emergencyReason:''};
    expect(()=>assertDirectIntakeAuthority(input)).not.toThrow();
    expect(()=>assertDirectIntakeAuthority({...input,policy:{...input.policy,'order.submit_positions':'CS'}})).toThrow('未配置');
    expect(()=>assertDirectIntakeAuthority({...input,positionCode:'CS'})).toThrow('客服代录');
    expect(()=>assertDirectIntakeAuthority({...input,positionCode:'HR_ADMIN'})).toThrow('协助原因');
    expect(()=>assertDirectIntakeAuthority({...input,positionCode:'HR_ADMIN',emergencyReason:'请假协助'})).not.toThrow();
    expect(()=>assertDirectIntakeAuthority({...input,positionCode:'HR_ADMIN',emergencyReason:'请假协助',policy:{...input.policy,'order.hr_emergency_enabled':'0'}})).toThrow('配置允许');
  });
});
