// A bounded set of common accidental encodings, not a general DLP system.
// Callers must still avoid sending credentials to models in the first place.
export function credentialVariants(secrets) {
  const variants=new Set();
  for(const value of secrets){
    if(typeof value!=='string'||!value)continue;
    variants.add(value);
    if(value.length<8)continue;
    const bytes=Buffer.from(value);
    variants.add(encodeURIComponent(value));
    variants.add(bytes.toString('base64'));
    variants.add(bytes.toString('base64url'));
    const escaped=[...bytes].map(byte=>'%'+byte.toString(16).padStart(2,'0').toUpperCase()).join('');
    variants.add(escaped);variants.add(escaped.toLowerCase());
  }
  return [...variants].sort((a,b)=>b.length-a.length);
}

export function redactVariants(text,variants,{partial=false}={}) {
  let value=String(text);
  if(partial){
    let withheld=0;
    for(const secret of variants){
      for(let size=Math.min(secret.length-1,value.length);size>withheld;size--){
        if(value.endsWith(secret.slice(0,size))){withheld=size;break;}
      }
    }
    if(withheld)value=value.slice(0,-withheld);
  }
  for(const secret of variants)value=value.replaceAll(secret,'[REDACTED]');
  return value;
}
