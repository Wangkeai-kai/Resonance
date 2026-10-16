(function(root){
  'use strict';
  function describe(error,code){
    const text=String(error||'');
    if(code==='model_invalid_structured_response'||/Expected .*JSON|JSON at position|valid JSON|任务数据格式|Unterminated string|Unexpected token.+JSON/i.test(text))return '模型返回的任务数据格式不正确，这一步已停止。已完成的进度保留，可以只继续未完成步骤。';
    if(code==='model_timeout'||/超时|timeout|未在.+秒内返回/i.test(text))return '模型没有在时限内完成，任务已停止等待。已完成的进度保留；可以换模型后继续，重试可能产生新的用量。';
    if(/token_budget_exceeded|预算/i.test(text))return '任务已达到本次预算。请先调整预算或拆分需求，再继续。';
    return '';
  }
  const api=Object.freeze({describe});root.TaskMessages=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
