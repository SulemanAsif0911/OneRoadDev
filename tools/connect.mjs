// Evaluate drivable network connectivity vs clearance threshold on the baked grid
import fs from 'fs';
const meta=JSON.parse(fs.readFileSync('public/arena/meta.json','utf8')); const buf=fs.readFileSync('public/arena/grid.bin');
const {nx,nz,res}=meta; const H=new Float32Array(nx*nz),B=new Uint8Array(nx*nz),F=new Uint8Array(nx*nz);
for(let k=0;k<nx*nz;k++){H[k]=buf.readInt16LE(k*4)*meta.quant;B[k]=buf.readUInt8(k*4+2);F[k]=buf.readUInt8(k*4+3);}
const drv=new Uint8Array(nx*nz); for(let k=0;k<nx*nz;k++){ if(H[k]<-900||B[k]||(F[k]&2))continue; drv[k]=1; }
const INF=1e9; const clr=new Float32Array(nx*nz);
for(let k=0;k<nx*nz;k++)clr[k]=drv[k]?INF:0;
const d1=1,d2=Math.SQRT2;
for(let z=0;z<nz;z++)for(let x=0;x<nx;x++){const k=z*nx+x;if(clr[k]===0)continue;let v=clr[k];
 if(x>0)v=Math.min(v,clr[k-1]+d1); if(z>0)v=Math.min(v,clr[k-nx]+d1); if(x>0&&z>0)v=Math.min(v,clr[k-nx-1]+d2); if(x<nx-1&&z>0)v=Math.min(v,clr[k-nx+1]+d2); clr[k]=v;}
for(let z=nz-1;z>=0;z--)for(let x=nx-1;x>=0;x--){const k=z*nx+x;if(clr[k]===0)continue;let v=clr[k];
 if(x<nx-1)v=Math.min(v,clr[k+1]+d1); if(z<nz-1)v=Math.min(v,clr[k+nx]+d1); if(x<nx-1&&z<nz-1)v=Math.min(v,clr[k+nx+1]+d2); if(x>0&&z<nz-1)v=Math.min(v,clr[k+nx-1]+d2); clr[k]=v;}
for(let k=0;k<nx*nz;k++) clr[k]*=res;
const NB=[[1,0],[-1,0],[0,1],[0,-1]];
for(const T of [2.0,2.5,3.0,3.5,4.0,4.5,5.0,6.0]){
  const pass=new Uint8Array(nx*nz); for(let k=0;k<nx*nz;k++) if(drv[k]&&clr[k]>=T)pass[k]=1;
  const comp=new Int32Array(nx*nz).fill(-1); const sizes=[];
  for(let k=0;k<nx*nz;k++){ if(!pass[k]||comp[k]>=0)continue; const id=sizes.length;const st=[k];comp[k]=id;let s=0;
   while(st.length){const c=st.pop();s++;const x=c%nx,z=(c-x)/nx;
    for(const [dx,dz] of NB){const a=x+dx,b=z+dz;if(a<0||b<0||a>=nx||b>=nz)continue;const nc=b*nx+a;if(pass[nc]&&comp[nc]<0){comp[nc]=id;st.push(nc);}}}
   sizes.push(s);}
  sizes.sort((a,b)=>b-a);
  const tot=sizes.reduce((a,b)=>a+b,0);
  console.log(`CLR>=${T}m: passable ${tot} cells, components ${sizes.length}, largest ${sizes[0]||0} (${((sizes[0]||0)/(tot||1)*100).toFixed(0)}% of passable)`);
}
// largest component at 3.0 mapped: how many street(painted) cells included?
