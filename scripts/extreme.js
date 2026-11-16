require(process.cwd()+'/assets/clusters.js');
const data=require(process.cwd()+'/data/lottery.json');
const C=require(process.cwd()+'/assets/core.js');
const S=require(process.cwd()+'/assets/schools.js');
require(process.cwd()+'/assets/models-ssq.js');
require(process.cwd()+'/assets/models-dlt.js');
const fs=require('fs');

let seed=24681357;
function rnd(){ seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296; }

const out={};
for(const gid of ['ssq','dlt']){
  const g=C.GAMES[gid], draws=data.games[gid].draws;
  const win=100,k=g.mainCount,poolMin=g.mainMin,size=g.mainMax-g.mainMin+1;
  const train=[],test=[];
  for(let i=0;i<100;i++){const f=S.makeFrame(g,draws,win,i); if(f)train.push(f);}
  for(let i=100;i<300;i++){const f=S.makeFrame(g,draws,win,i); if(f)test.push(f);}
  const F=train[0].picks.length;
  const ones=new Array(F).fill(1);
  const baseTrain=S.evalFrames(train,ones,k,poolMin,size);
  const baseTest=S.evalFrames(test,ones,k,poolMin,size);

  // 随机搜索最优
  let best=null,bestScore=0;
  for(let t=0;t<2000;t++){
    const w=new Array(F);
    for(let i=0;i<F;i++) w[i]= rnd()<0.3?1:Math.exp((rnd()*2-1)*Math.log(10));
    const sc=S.evalFrames(train,w,k,poolMin,size);
    if(sc>bestScore){bestScore=sc;best=w.slice();}
  }
  const searchTest=S.evalFrames(test,best,k,poolMin,size);

  // 作弊：训练集直接用开奖号，样本外用随机
  let cheatHit=0;
  train.forEach(f=>{ cheatHit+=k; }); // 每期全中
  const cheatTrain=cheatHit/train.length;

  out[gid]={
    game:g.id, name:g.name,
    random:+(baseTrain).toFixed(3),
    n:train.length, testN:test.length,
    strategies:[
      {name:'随机选号（基准）', train:+baseTrain.toFixed(3), test:+baseTest.toFixed(3), note:'不做任何计算'},
      {name:'冠军公式（当前线上）', train:1.320, test:null, note:'72 个公式里最近 100 期最好的一个'},
      {name:'随机搜索 2000 组权重', train:+bestScore.toFixed(3), test:+searchTest.toFixed(3), note:'在训练集上找最优权重组合'},
      {name:'抄开奖号（作弊）', train:+(cheatTrain).toFixed(3), test:+baseTest.toFixed(3), note:'训练时直接照抄当期号码，现实中下一期抄不到'},
    ],
  };
  console.log(`${g.name}: 随机 ${baseTrain.toFixed(3)} | 搜索最优 训练 ${bestScore.toFixed(3)} 样本外 ${searchTest.toFixed(3)} | 作弊 训练 ${cheatTrain.toFixed(1)} 样本外 ${baseTest.toFixed(3)}`);
}
fs.writeFileSync('data/extreme.json', JSON.stringify(out,null,1)+'\n','utf8');
console.log('写入 data/extreme.json');
