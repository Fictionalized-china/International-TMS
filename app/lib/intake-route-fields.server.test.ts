import {beforeEach,describe,it,expect,vi} from "vitest";
const mock=vi.hoisted(()=>({references:[] as {category:string;code:string;name:string}[],bind:vi.fn()}));
vi.mock('cloudflare:workers',()=>({env:{DB:{prepare:()=>({bind:(organizationId:string)=>{
  mock.bind(organizationId);return{all:async()=>({results:mock.references})};
}})}}}));
import {resolveIntakeRouteFields} from './intake-route-fields.server';
const enabled=()=>({isActive:true,isRequired:false});
beforeEach(()=>{mock.references=[];mock.bind.mockClear();});
describe('intake route validation',()=>{
  it('reports all four missing direct-intake fields in one response',async()=>{
    await expect(resolveIntakeRouteFields({organizationId:'org',form:new FormData(),direct:true,policy:enabled}))
      .rejects.toThrow('请填写“出境口岸”；请填写“中转地”；请填写“清关地”；请填写“国内代理”');
    expect(mock.bind).not.toHaveBeenCalled();
  });
  it('does not revalidate unchanged historical references after they are disabled',async()=>{
    const existing={exit_port:'OLD',transit_locations:'OLD-TRANSIT',customs_location:'OLD-CUSTOMS',domestic_agent:'代理'};
    const form=new FormData();form.set('exitPort','OLD');
    expect(await resolveIntakeRouteFields({organizationId:'org',form,direct:false,policy:enabled,existing})).toEqual(existing);
    expect(mock.bind).not.toHaveBeenCalled();
  });
  it('ignores hidden auxiliary inputs but does not grant that bypass to direct intake',async()=>{
    const form=new FormData();form.set('exitPort','fake');
    const policy=()=>({isActive:false,isRequired:false});
    expect(await resolveIntakeRouteFields({organizationId:'org',form,direct:false,policy})).toEqual({exit_port:null,transit_locations:null,customs_location:null,domestic_agent:null});
    await expect(resolveIntakeRouteFields({organizationId:'org',form,direct:true,policy})).rejects.toThrow('出境口岸');
    expect(mock.bind).toHaveBeenCalledWith('org');
  });
  it.each(['a'.repeat(201),'bad\nname'])('rejects invalid domestic-agent content',async domesticAgent=>{
    const form=new FormData();form.set('domesticAgent',domesticAgent);
    await expect(resolveIntakeRouteFields({organizationId:'org',form,direct:false,policy:enabled})).rejects.toThrow('国内代理');
  });
  it('rejects a file submitted in a scalar domestic-agent input',async()=>{
    const form=new FormData();form.set('domesticAgent',new File(['x'],'agent.txt'));
    await expect(resolveIntakeRouteFields({organizationId:'org',form,direct:false,policy:enabled})).rejects.toThrow('不能上传文件代替');
  });
});
