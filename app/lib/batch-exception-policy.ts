export type ExceptionLifecycleStatus="open"|"processing"|"resolved"|"cancelled";
export type ExceptionSeverity="low"|"medium"|"high"|"critical";
export type OrderExceptionStatus="normal"|"warning"|"exception";

export function isActiveExceptionStatus(status:ExceptionLifecycleStatus){
  return status==="open"||status==="processing";
}

export function orderExceptionStatusForSeverities(severities:readonly ExceptionSeverity[]):OrderExceptionStatus{
  if(severities.some(severity=>severity==="high"||severity==="critical"))return"exception";
  return severities.length?"warning":"normal";
}

export function hasBlockingActiveException(exceptions:readonly {status:ExceptionLifecycleStatus;blocksProgress:boolean|number}[]){
  return exceptions.some(item=>isActiveExceptionStatus(item.status)&&Boolean(item.blocksProgress));
}
