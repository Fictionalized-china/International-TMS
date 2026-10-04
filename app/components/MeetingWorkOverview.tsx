import { Link } from "react-router";
export function MeetingWorkOverview({overview}:{overview:{dispatch:number;daily:number;signatures:number;items:{title:string;href:string}[]}}) {
  return <section className="panel"><div className="panel-header"><h2>本岗专项工作总览</h2><p>按当前岗位、个人责任和配置统计；下方仅列前 15 项快捷入口，计数不截断。</p></div><div className="row-actions"><span>待商务找车 {overview.dispatch}</span><span>今日运踪待更新 {overview.daily}</span><span>可办理费用签核 {overview.signatures}</span></div>{overview.items.length?<ul>{overview.items.map((item,i)=><li key={i}><Link to={item.href}>{item.title}</Link></li>)}</ul>:<p>当前无专项待办，业务节点待办见订单台账。</p>}</section>;
}
