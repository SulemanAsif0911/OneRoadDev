// Minimal GLB loader: accessors + scene traversal + subtree bounds
import fs from 'fs';
export function loadGLB(file){
  const buf=fs.readFileSync(file);
  let off=12,json=null,binOff=0,binLen=0;
  while(off<buf.length){const cl=buf.readUInt32LE(off),ct=buf.readUInt32LE(off+4);
    if(ct===0x4E4F534A)json=JSON.parse(buf.slice(off+8,off+8+cl).toString('utf8'));
    else if(ct===0x004E4942){binOff=off+8;binLen=cl;}
    off+=8+cl;}
  return {buf,json,binOff,binLen};
}
const CT={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4};
const NC={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16};
export function readAccessor(d,ai,stride){
  const g=d.json,a=g.accessors[ai],bv=g.bufferViews[a.bufferView];
  const base=d.binOff+(bv.byteOffset||0)+(a.byteOffset||0);
  const nc=NC[a.type],n=a.count*nc;
  const csz=CT[a.componentType];
  const str=bv.byteStride&&stride!==false?bv.byteStride:0;
  const out=new (a.componentType===5126?Float32Array:a.componentType===5125?Uint32Array:a.componentType===5123?Uint16Array:Uint8Array)(n);
  for(let i=0;i<a.count;i++){
    const rowStart=base+(str?i*str:i*nc*csz);
    for(let c=0;c<nc;c++){
      const o=rowStart+c*csz;
      out[i*nc+c]= a.componentType===5126?d.buf.readFloatLE(o):a.componentType===5125?d.buf.readUInt32LE(o):a.componentType===5123?d.buf.readUInt16LE(o):a.componentType===5122?d.buf.readInt16LE(o):d.buf.readUInt8(o);
    }
  }
  return out;
}
export function nodeMat(n){
  if(n.matrix)return n.matrix.slice();
  const t=n.translation||[0,0,0],r=n.rotation||[0,0,0,1],s=n.scale||[1,1,1];
  const[x,y,z,w]=r,x2=x+x,y2=y+y,z2=z+z,xx=x*x2,xy=x*y2,xz=x*z2,yy=y*y2,yz=y*z2,zz=z*z2,wx=w*x2,wy=w*y2,wz=w*z2;
  return [(1-(yy+zz))*s[0],(xy+wz)*s[0],(xz-wy)*s[0],0,(xy-wz)*s[1],(1-(xx+zz))*s[1],(yz+wx)*s[1],0,(xz+wy)*s[2],(yz-wx)*s[2],(1-(xx+yy))*s[2],0,t[0],t[1],t[2],1];
}
export function mul(a,b){const o=new Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++){let s=0;for(let k=0;k<4;k++)s+=a[k*4+r]*b[c*4+k];o[c*4+r]=s;}return o;}
export function xf(m,p){return[m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]];}
export function invert(m){
  const o=new Array(16);
  const a00=m[0],a01=m[1],a02=m[2],a03=m[3],a10=m[4],a11=m[5],a12=m[6],a13=m[7],a20=m[8],a21=m[9],a22=m[10],a23=m[11],a30=m[12],a31=m[13],a32=m[14],a33=m[15];
  const b00=a00*a11-a01*a10,b01=a00*a12-a02*a10,b02=a00*a13-a03*a10,b03=a01*a12-a02*a11,b04=a01*a13-a03*a11,b05=a02*a13-a03*a12,
        b06=a20*a31-a21*a30,b07=a20*a32-a22*a30,b08=a20*a33-a23*a30,b09=a21*a32-a22*a31,b10=a21*a33-a23*a31,b11=a22*a33-a23*a32;
  let det=b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06; if(!det)return null; det=1/det;
  o[0]=(a11*b11-a12*b10+a13*b09)*det; o[1]=(a02*b10-a01*b11-a03*b09)*det; o[2]=(a31*b05-a32*b04+a33*b03)*det; o[3]=(a22*b04-a21*b05-a23*b03)*det;
  o[4]=(a12*b08-a10*b11-a13*b07)*det; o[5]=(a00*b11-a02*b08+a03*b07)*det; o[6]=(a32*b02-a30*b05-a33*b01)*det; o[7]=(a20*b05-a22*b02+a23*b01)*det;
  o[8]=(a10*b10-a11*b08+a13*b06)*det; o[9]=(a01*b08-a00*b10-a03*b06)*det; o[10]=(a30*b04-a31*b02+a33*b00)*det; o[11]=(a21*b02-a20*b04-a23*b00)*det;
  o[12]=(a11*b07-a10*b09-a12*b06)*det; o[13]=(a00*b09-a01*b07+a02*b06)*det; o[14]=(a31*b01-a30*b03-a32*b00)*det; o[15]=(a20*b03-a21*b01+a22*b00)*det;
  return o;
}
export function buildScene(d){
  const g=d.json, world=new Array(g.nodes.length), info=new Array(g.nodes.length);
  const parentOf={};
  for(let i=0;i<g.nodes.length;i++)for(const c of g.nodes[i].children||[])parentOf[c]=i;
  const walk=(i,p)=>{const n=g.nodes[i];const m=mul(p,nodeMat(n));world[i]=m;for(const c of n.children||[])walk(c,m);};
  for(const s of g.scenes[g.scene||0].nodes)walk(s,[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
  // own-mesh bounds per node (world space)
  for(let i=0;i<g.nodes.length;i++){
    const n=g.nodes[i];let mn=null,mx=null,tris=0,verts=0;
    if(n.mesh!==undefined)for(const p of g.meshes[n.mesh].primitives){
      const a=g.accessors[p.attributes.POSITION];
      if(a.min&&a.max)for(let c=0;c<8;c++){
        const q=xf(world[i],[(c&1?a.max:a.min)[0],(c&2?a.max:a.min)[1],(c&4?a.max:a.min)[2]]);
        if(!mn){mn=[...q];mx=[...q];}
        else for(let k=0;k<3;k++){mn[k]=Math.min(mn[k],q[k]);mx[k]=Math.max(mx[k],q[k]);}
      }
      verts+=a.count; tris+=p.indices!==undefined?g.accessors[p.indices].count/3:a.count/3;
    }
    info[i]={i,name:n.name||'',mn,mx,tris,verts,mesh:n.mesh,material:n.mesh!==undefined?g.meshes[n.mesh].primitives[0].material:undefined};
  }
  // subtree bounds
  const sub=new Array(g.nodes.length);
  const calc=(i)=>{let mn=null,mx=null;const own=info[i];
    const acc=(a,b)=>{if(!a)return b?[...b]:null;if(!b)return a;return[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.min(a[2],b[2]),Math.max(a[3],b[3]),Math.max(a[4],b[4]),Math.max(a[5],b[5])];};
    if(own.mn)mn=[own.mn[0],own.mn[1],own.mn[2],own.mx[0],own.mx[1],own.mx[2]];
    for(const c of g.nodes[i].children||[])mn=acc(mn,calc(c));
    sub[i]=mn;return mn;};
  for(const s of g.scenes[g.scene||0].nodes)calc(s);
  return {g,world,info,sub,parentOf};
}
