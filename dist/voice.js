(() => {
  let recognition,active=false,session=0;
  const note=text=>{let node=document.getElementById('voiceNote');if(!node){node=document.createElement('p');node.id='voiceNote';node.className='voice-note';node.setAttribute('role','status');document.querySelector('#chatForm')?.before(node);}node.textContent=text;};
  const state=value=>{active=value;document.querySelector('#chatVoice')?.setAttribute('aria-pressed',String(value));document.querySelector('#chatVoice')?.setAttribute('aria-label',value?'停止语音输入':'语音输入');};
  const cancelRecognition=()=>{session++;const previous=recognition;recognition=null;state(false);try{previous?.abort();}catch{}};
  // Navigation can also happen through programmatic chat entry points. Invalidate
  // callbacks before aborting: browsers may still deliver a queued final result.
  document.addEventListener('gongming:chat-context-changing',cancelRecognition);
  document.addEventListener('click',event=>{if(event.target.closest('#chatSend,#chatNew,#chatCreateTeam,#chatTransfer,#chatDelete,[data-view],[data-chat-id],[data-direct-provider],[data-chat-task],[data-chat-prompt]'))cancelRecognition();},true);
  document.addEventListener('submit',event=>{if(event.target.closest('#chatForm'))cancelRecognition();},true);
  document.addEventListener('keydown',event=>{if(event.target.closest('#chatText')&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing)cancelRecognition();},true);
  document.addEventListener('gongming:dictation',event=>note(event.detail?.ok?'已请求 Windows 语音输入。说完后检查文字，再点击发送；可按 Win + H 关闭。':'未能打开系统语音输入。请把光标放在输入框，按 Win + H。'));
  document.addEventListener('click',event=>{
    if(!event.target.closest('#chatVoice'))return;const input=document.querySelector('#chatText');if(!input||input.disabled)return;input.focus();input.setSelectionRange(input.value.length,input.value.length);
    if(window.gongmingDesktop?.platform==='win32'){note('正在打开 Windows 语音输入。识别由系统处理，语言和隐私选项在 Windows 设置中管理。');return;}
    if(active){recognition?.stop();return;}
    const Speech=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!Speech){note(/Win/.test(navigator.platform)?'将光标放在输入框，按 Win + H 开始系统语音输入。':'此浏览器不支持语音识别，请使用系统听写输入。');return;}
    note('正在请求麦克风。识别文字会留在输入框，不会自动发送。');
    const current=++session,speech=new Speech(),base=input.value;let finalText='';recognition=speech;speech.lang='zh-CN';speech.continuous=true;speech.interimResults=true;
    const isCurrent=()=>current===session&&recognition===speech;
    speech.onstart=()=>{if(!isCurrent())return;state(true);note('正在聆听… 点击麦克风停止。语音由浏览器的识别服务处理，识别文字不会自动发送。');};
    speech.onresult=e=>{if(!isCurrent())return;if(input.disabled||input!==document.querySelector('#chatText')){cancelRecognition();return;}let interim='';for(let i=e.resultIndex;i<e.results.length;i++){if(e.results[i].isFinal)finalText+=e.results[i][0].transcript;else interim+=e.results[i][0].transcript;}input.value=(base+(base?'\n':'')+finalText+interim).slice(0,20000);input.dispatchEvent(new Event('input',{bubbles:true}));};
    speech.onerror=e=>{if(!isCurrent())return;note(({ 'not-allowed':'麦克风权限未开启，请在浏览器设置中允许。',network:'语音识别服务暂时不可用，可以使用系统听写。','no-speech':'没有识别到语音，请再次点击麦克风。'})[e.error]||'语音输入未完成，请重试或使用系统听写。');cancelRecognition();};
    speech.onend=()=>{if(!isCurrent())return;recognition=null;state(false);};try{speech.start();}catch{if(isCurrent()){cancelRecognition();note('无法启动语音输入，请使用系统听写。');}}
  });
})();
