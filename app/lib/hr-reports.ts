export function reportCsv(rows:readonly (readonly unknown[])[]) {
  return "\uFEFF"+rows.map(row=>row.map(value=>{let text=String(value??"");if(/^\s*[=+@-]/.test(text)) text=`'${text}`;return `"${text.replaceAll('"','""')}"`;}).join(",")).join("\r\n");
}
export function hrReportPeriod(now:Date,kind:"week"|"month",previous=false) {
  const day=new Date(now.getTime()+8*3600*1000),end=new Date(Date.UTC(day.getUTCFullYear(),day.getUTCMonth(),day.getUTCDate()));
  let from:Date,to:Date;
  if(kind==="month") {from=new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth()-(previous?1:0),1));to=previous?new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth(),0)):end;}
  else {const monday=new Date(end.getTime()-((end.getUTCDay()+6)%7)*86400000);from=new Date(monday.getTime()-(previous?7:0)*86400000);to=previous?new Date(monday.getTime()-86400000):end;}
  return {from:from.toISOString().slice(0,10),to:to.toISOString().slice(0,10)};
}
