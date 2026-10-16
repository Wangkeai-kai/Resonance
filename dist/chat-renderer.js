(() => {
  'use strict';
  function morph(oldNode,newNode) {
    if(oldNode.nodeType!==newNode.nodeType||oldNode.nodeName!==newNode.nodeName){oldNode.replaceWith(newNode);return newNode;}
    if(oldNode.nodeType===Node.TEXT_NODE){if(oldNode.data!==newNode.data)oldNode.data=newNode.data;return oldNode;}
    if(oldNode.nodeType!==Node.ELEMENT_NODE)return oldNode;
    const open=oldNode.tagName==='DETAILS'?oldNode.open:undefined;
    for(const attr of [...oldNode.attributes])if(!newNode.hasAttribute(attr.name))oldNode.removeAttribute(attr.name);
    for(const attr of newNode.attributes)if(oldNode.getAttribute(attr.name)!==attr.value)oldNode.setAttribute(attr.name,attr.value);
    if(open!==undefined)oldNode.open=open;
    const desired=[...newNode.childNodes];
    for(let i=0;i<desired.length;i++){
      const current=oldNode.childNodes[i];if(!current)oldNode.append(desired[i]);else morph(current,desired[i]);
    }
    while(oldNode.childNodes.length>desired.length)oldNode.lastChild.remove();
    return oldNode;
  }
  function parse(html){const template=document.createElement('template');template.innerHTML=html;return template.content.firstElementChild;}
  function order(parent,children) {
    children.forEach((child,index)=>{if(parent.children[index]!==child)parent.insertBefore(child,parent.children[index]||null);});
    const keep=new Set(children);for(const child of [...parent.children])if(!keep.has(child))child.remove();
  }
  function create() {
    let current='',nodes=new Map(),groups=new Map();
    function message(item,stamp,render){
      let entry=nodes.get(item.id);
      if(!entry){entry={node:parse(render()),stamp};nodes.set(item.id,entry);}
      else if(entry.stamp!==stamp){morph(entry.node,parse(render()));entry.stamp=stamp;}
      return entry.node;
    }
    function group(key,header,children,footer){
      let entry=groups.get(key);
      if(!entry){const node=document.createElement('section');node.className='chat-model-streams';node.setAttribute('aria-label','各模型的流式输出');entry={node,header:document.createElement('header'),footer:document.createElement('div')};groups.set(key,entry);}
      if(entry.headerHtml!==header){entry.header.innerHTML=header;entry.headerHtml=header;}
      if(entry.footerHtml!==footer){entry.footer.innerHTML=footer;entry.footerHtml=footer;}
      order(entry.node,[entry.header,...children,...(footer?[entry.footer]:[])]);return entry.node;
    }
    return {
      begin(id){if(current!==id){current=id;nodes.clear();groups.clear();}},message,group,
      commit(target,children,ids,groupIds){order(target,children);for(const key of nodes.keys())if(!ids.has(key))nodes.delete(key);for(const key of groups.keys())if(!groupIds.has(key))groups.delete(key);},
      reset(){current='';nodes.clear();groups.clear();},morph,
    };
  }
  window.ChatRenderer=Object.freeze({create});
})();
