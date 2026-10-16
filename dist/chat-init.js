let initialView='chat';try{const saved=localStorage.getItem('gongming.last-view');if(['discover','chat','results','runtime'].includes(saved))initialView=saved;}catch{}
window.Gongming?.openView(initialView);
