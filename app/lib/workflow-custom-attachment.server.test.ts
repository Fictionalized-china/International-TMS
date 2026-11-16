import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {env} from 'cloudflare:workers';
import {meetingFixture,seedFrozenMeetingWorkflow} from './meeting-integration-fixture';
import {loadOrderModuleWorkflowFields,saveOrderCustomWorkflowFieldValue} from './workflow-fields.server';
vi.mock('cloudflare:workers',()=>({env:{}}));
let fixture:Awaited<ReturnType<typeof meetingFixture>>;
beforeEach(async()=>{
  fixture=await meetingFixture();Object.assign(env,{DB:fixture.db});seedFrozenMeetingWorkflow(fixture);
  fixture.database.exec("UPDATE order_module_instances SET enabled=1 WHERE module_code='costs'");
  fixture.database.prepare("INSERT INTO workflow_instance_fields(id,instance_id,workflow_id,step_key,module_code,field_key,label,field_type,is_required,is_active,handler_position_codes,created_at) VALUES('file-field','instance','wf','reconciliation','costs','custom_test_file','核对附件','attachment',1,1,'CS',?)").run(fixture.now);
});
afterEach(()=>{vi.restoreAllMocks();fixture?.database.close();});
const file=()=>new File(['%PDF-1.4\nlocal isolated fixture\n%%EOF'],'本地隔离核对.pdf',{type:'application/pdf'});
const save=(attachment:File|null=file())=>saveOrderCustomWorkflowFieldValue({organizationId:'org',orderId:'order',moduleCode:'costs',fieldId:'file-field',value:'not-an-attachment',file:attachment,actorUserId:'cs',actorPositionCode:'CS',actorRoleCodes:['pos_customer_service']});
describe('frozen custom attachment fields store actual scoped files',()=>{
  it('does not accept arbitrary text as a required attachment',async()=>{await expect(save(null)).rejects.toThrow('不能用文字');expect(fixture.database.prepare('SELECT COUNT(*) n FROM order_attachments').get()).toEqual({n:0});});
  it('stores the file and value together, displays its name and retains it after an empty save',async()=>{
    await save();const stored=fixture.database.prepare("SELECT value_text FROM order_custom_workflow_field_values WHERE field_instance_id='file-field'").get();
    const fields=await loadOrderModuleWorkflowFields('org','order','costs');expect(fields.find(field=>field.fieldKey==='custom_test_file')).toMatchObject({present:true,displayValue:'本地隔离核对.pdf',attachmentId:stored?.value_text});
    await save(null);expect(fixture.database.prepare('SELECT COUNT(*) n FROM order_attachments').get()).toEqual({n:1});
  });
  it('does not treat an attachment belonging to another order as this field evidence',async()=>{
    fixture.database.prepare("INSERT INTO order_custom_workflow_field_values(id,organization_id,order_id,field_instance_id,value_text,created_at,updated_at) VALUES('invalid','org','order','file-field','missing-or-another-order',?,?)").run(fixture.now,fixture.now);
    const fields=await loadOrderModuleWorkflowFields('org','order','costs');expect(fields.find(field=>field.fieldKey==='custom_test_file')).toMatchObject({present:false,attachmentId:null});
  });
  it('keeps configured intake attachments editable by the actual sales node owner without granting module-wide manage',async()=>{
    fixture.database.exec("UPDATE transport_orders SET current_assignee_user_id='sales' WHERE id='order'; UPDATE workflow_instance_fields SET handler_position_codes='SALES' WHERE id='file-field'");
    fixture.database.prepare("DELETE FROM role_permissions WHERE permission_code='order.module.costs.manage' AND role_id IN (SELECT id FROM roles WHERE organization_id='org' AND code=?)").run(fixture.actors.get('sales')!.roleCodes[0]);
    await saveOrderCustomWorkflowFieldValue({organizationId:'org',orderId:'order',moduleCode:'costs',fieldId:'file-field',value:null,file:file(),actorUserId:'sales',actorPositionCode:'SALES',actorRoleCodes:fixture.actors.get('sales')!.roleCodes});
    expect(fixture.database.prepare('SELECT COUNT(*) n FROM order_attachments').get()).toEqual({n:1});
  });
  it('rolls back the field, file and audit if the node changes before commit',async()=>{
    const batch=fixture.db.batch.bind(fixture.db);vi.spyOn(fixture.db,'batch').mockImplementationOnce(async statements=>{fixture.database.exec("UPDATE workflow_instances SET current_step_key='order_creation' WHERE id='instance'");return batch(statements);});
    await expect(save()).rejects.toThrow('本次未保存');expect(fixture.database.prepare('SELECT COUNT(*) n FROM order_attachments').get()).toEqual({n:0});expect(fixture.database.prepare('SELECT COUNT(*) n FROM order_custom_workflow_field_values').get()).toEqual({n:0});
  });
  it('refuses disabled file authors even when an old caller passes boss roles',async()=>{fixture.database.exec("UPDATE users SET status='disabled' WHERE id='cs'");await expect(save()).rejects.toThrow('权限已变化');});
  it('keeps existing supported formats and size limits',async()=>{await expect(save(new File(['<script>bad()</script>'],'bad.svg',{type:'image/svg+xml'}))).rejects.toThrow('仅支持');await expect(save(new File([new Uint8Array(1_300_000)],'large.pdf',{type:'application/pdf'}))).rejects.toThrow('1.2MB');});
});
