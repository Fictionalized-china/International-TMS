export type OutstandingItem={id:string;outstanding:number};

export function allocateToOutstanding(items:OutstandingItem[],requested:number){
  if(!Number.isFinite(requested)||requested<=0)throw new Error("分配金额必须大于 0");
  const available=items.reduce((sum,item)=>sum+Math.max(0,item.outstanding),0);
  if(requested-available>0.009)throw new Error("分配金额超过当前未处理余额");
  let cents=Math.round(requested*100);
  return items.flatMap(item=>{
    const allocated=Math.min(cents,Math.round(Math.max(0,item.outstanding)*100));
    cents-=allocated;
    return allocated>0?[{id:item.id,amount:allocated/100}]:[];
  });
}

export function settlementDocumentNumber(prefix:"REC"|"PAY"|"TAX"|"CASH",now=new Date()){
  const date=now.toISOString().slice(0,10).replaceAll("-","");
  return `${prefix}${date}${crypto.randomUUID().replaceAll("-","").slice(0,6).toUpperCase()}`;
}
