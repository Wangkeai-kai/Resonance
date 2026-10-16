import test from 'node:test';
import assert from 'node:assert/strict';
import {bundleWebsite} from '../lib/website-bundle.mjs';

const html=(assets='<link rel="stylesheet" href="./styles/site.css"><script defer src="scripts/app.js"></script>')=>'<html><head><title>Local bundle</title>'+assets+'</head><body><button id="run">Run</button></body></html>';
const files=(index=html())=>[{path:'index.html',content:index},{path:'styles/site.css',content:'body { color: #246; }'},{path:'scripts/app.js',content:'document.body.dataset.ready = "yes";'}];

test('generated relative styles and scripts become a standalone preview while source remains untouched',()=>{
 const source=files(),before=structuredClone(source),bundled=bundleWebsite(source);
 assert.match(bundled,/<style>body \{ color: #246; \}<\/style>/);assert.match(bundled,/<script>document.body.dataset.ready = "yes";<\/script>/);
 assert.ok(!bundled.includes('src='));assert.ok(!bundled.includes('href='));assert.deepEqual(source,before);
});

test('local bundling rejects missing, remote, absolute and traversal asset references',()=>{
 for(const reference of ['missing.js','https://example.com/app.js','http://localhost/private.js','//example.com/app.js','/app.js','../outside.js','./../outside.js','file:///c:/private.js','C:\\private.js','scripts/app.js?token=abc','scripts/app.js#part']){
   assert.throws(()=>bundleWebsite(files(html('<script src="'+reference+'"></script>'))),{status:400},reference);
 }
 assert.throws(()=>bundleWebsite(files(html('<link rel="stylesheet" href="missing.css">'))),{status:400});
 assert.throws(()=>bundleWebsite([{path:'app.js',content:'anything'}]),{status:400});
});

test('script and style strings cannot close their generated embedding element',()=>{
 const bundled=bundleWebsite([{path:'index.html',content:html('<link rel="stylesheet" href="style.css"><script src="app.js"></script>')},{path:'style.css',content:'a::after { content: "</STYLE><script>bad()</script>"; }'},{path:'app.js',content:'const example = "</SCRIPT><img src=x onerror=bad()>";'}]);
 assert.match(bundled,/content: "<\\\/style>/i);assert.match(bundled,/example = "<\\\/script>/i);
 assert.equal((bundled.match(/<\/style>/gi)||[]).length,1);assert.equal((bundled.match(/<\/script>/gi)||[]).length,2);
});

test('module asset scripts require an explicit build rather than silently breaking module imports',()=>{
 assert.throws(()=>bundleWebsite(files(html('<script type="module" src="scripts/app.js"></script>'))),{status:400});
 assert.throws(()=>bundleWebsite(files(html('<script src="scripts/app.js" type="module"></script>'))),{status:400});
});

test('quoted and unquoted safe attributes resolve while examples inside raw text stay untouched',()=>{
 const source=files(html('<LINK href=styles/site.css REL=stylesheet><script src=scripts/app.js></script>'));
 assert.match(bundleWebsite(source),/<style>body/);assert.match(bundleWebsite(source),/<script>document.body/);
 const examples='<!-- <script src="https://remote.example/example.js"></script> --><textarea><link rel=stylesheet href=https://remote.example/style.css></textarea><script>const example = "<link rel=stylesheet href=example.css>";</script>';
 assert.ok(bundleWebsite(files(html(examples))).includes(examples));
});

test('deferred scripts run after markup and keep their relative order',()=>{
 const bundled=bundleWebsite([{path:'index.html',content:html('<script src=first.js defer></script><script defer src=second.js></script>')},{path:'first.js',content:'window.first = document.querySelector("#run");'},{path:'second.js',content:'window.second = window.first;'}]);
 assert.ok(bundled.indexOf('window.first')>bundled.indexOf('<button'));assert.ok(bundled.indexOf('window.second')>bundled.indexOf('window.first'));
});

test('unsupported resource forms fail with an explicit error rather than losing behavior',()=>{
 for(const markup of ['<script src=https://remote.example/app.js></script>','<link rel=stylesheet href=../outside.css>','<script type=module>import "./x.js";</script>','<script src=scripts/app.js type=module></script>','<script>import("./chunk.js")</script>','<script>const x = `${import("./chunk.js")}`;</script>','<script src=scripts/app.js async></script>','<script src=scripts/app.js src=other.js></script>','<link rel=stylesheet href=styles/site.css href=other.css>','<script src=scripts/app.js>inline()</script>','<script src=scripts/app.js>','<script src="scripts/app.js></script>','<link rel=stylesheet>','<link rel=modulepreload href=module.js>'])assert.throws(()=>bundleWebsite(files(html(markup))),{status:400},markup);
 assert.throws(()=>bundleWebsite([...files(),{path:'scripts/app.js',content:'duplicate'}]),{status:400});
 for(const css of ['@import "https://remote.example/style.css";','body { background: url(https://remote.example/bg.png); }','@font-face { src: url(./font.woff2); }'])assert.throws(()=>bundleWebsite([{path:'index.html',content:html('<link rel=stylesheet href=style.css>')},{path:'style.css',content:css}]),{status:400});
 assert.doesNotThrow(()=>bundleWebsite(files(html('<script>const example="import(\\"./x.js\\")"; object.import("okay");</script>'))));
 assert.doesNotThrow(()=>bundleWebsite([{path:'index.html',content:html('<link rel=stylesheet href=style.css>')},{path:'style.css',content:'body { background: url("data:image/png;base64,AAA="); }'}]));
});
