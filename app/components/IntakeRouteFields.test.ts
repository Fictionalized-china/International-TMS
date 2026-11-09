import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,it,expect} from "vitest";
import {IntakeRouteFields} from "./IntakeRouteFields";

describe('intake route inputs',()=>{
  it('shows four labelled required fields for direct intake even if the auxiliary quote configuration hides them',()=>{
    const html=renderToStaticMarkup(createElement(IntakeRouteFields,{references:[],direct:true,policy:()=>({isActive:false,isRequired:false})}));
    expect(html.match(/<label /g)).toHaveLength(4);
    expect(html.match(/required=""/g)).toHaveLength(4);
    expect(html).toContain('国内代理');expect(html).toContain('RO 代理分别记录');
    expect(html).toContain('暂无可选项');expect(html).not.toContain('name="roAgent"');
  });
  it('retains historical reference values and their input while hiding inactive auxiliary fields',()=>{
    const html=renderToStaticMarkup(createElement(IntakeRouteFields,{references:[],values:{exit_port:'OLD'},policy:key=>({isActive:key==='quotation_exit_port',isRequired:false})}));
    expect(html).toContain('历史值：OLD');expect(html).toContain('selected=""');
    expect(html).not.toContain('name="domesticAgent"');
  });
});
