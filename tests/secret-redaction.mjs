import test from 'node:test';
import assert from 'node:assert/strict';
import {credentialVariants,redactVariants} from '../lib/secret-redaction.mjs';

test('redacts raw and common encoded credentials without exporting keys',()=>{
  const secret='fixture-credential/with+symbols=123',variants=credentialVariants([secret]);
  for(const value of variants)assert.equal(redactVariants('prefix '+value+' suffix',variants),'prefix [REDACTED] suffix');
  assert.equal(redactVariants('ordinary source text',variants),'ordinary source text');
});
test('stream chunks withhold any incomplete raw or encoded credential prefix',()=>{
  const secret='fixture-credential-123456789',variants=credentialVariants([secret]);
  for(const value of variants){
    for(let position=1;position<value.length;position++)assert.equal(redactVariants('Response: '+value.slice(0,position),variants,{partial:true}),'Response: ');
    // An unpadded encoding may still be a prefix of the padded variant, so it
    // can remain withheld until the final event or following ordinary text.
    assert.ok(['Response: ','Response: [REDACTED]'].includes(redactVariants('Response: '+value,variants,{partial:true})));
    assert.equal(redactVariants('Response: '+value,variants),'Response: [REDACTED]');
  }
  assert.equal(redactVariants('fin',credentialVariants(['fixture-token']),{partial:false}),'fin');
});
