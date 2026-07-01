const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');

const PORT = process.env.PORT || 8787;
const DB_PATH = path.join(__dirname, 'data', 'vigor.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ── banco de dados persistente ─────────────────────────────────
// Em produção (Render, etc.) defina TURSO_DATABASE_URL e TURSO_AUTH_TOKEN
// para usar um banco libSQL remoto persistente (ex: Turso — turso.tech).
// Sem essas variáveis, cai no arquivo local (./data/vigor.db), útil só
// para desenvolvimento — em hosts com disco efêmero (Render free) os
// dados locais SEMPRE são perdidos a cada deploy/restart.
const usingRemoteDb = !!process.env.TURSO_DATABASE_URL;
if (!usingRemoteDb) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || `file:${DB_PATH}`,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ── helpers de acesso ao banco (compatíveis com o estilo antigo) ─
// dbGet: retorna 1 linha (ou undefined). dbAll: retorna array de linhas.
// dbRun: executa insert/update/delete e retorna metadados.
async function dbGet(sql, ...args) {
  const r = await db.execute({ sql, args });
  return r.rows[0];
}
async function dbAll(sql, ...args) {
  const r = await db.execute({ sql, args });
  return r.rows;
}
async function dbRun(sql, ...args) {
  return db.execute({ sql, args });
}

async function initDb() {
  await db.execute('PRAGMA foreign_keys = ON;');
  await db.executeMultiple(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

// ── helpers gerais ──────────────────────────────────────────
function uid(p){ return (p?p+'_':'')+crypto.randomBytes(8).toString('hex'); }
function now(){ return new Date().toISOString(); }
function round1(n){ return Math.round(n*10)/10; }
function round2(n){ return Math.round(n*100)/100; }

// ── auth ─────────────────────────────────────────────────────
function hashPassword(pw){
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(pw, salt, 10000, 64, 'sha512').toString('hex');
  return { hash, salt };
}
function verifyPassword(pw, hash, salt){
  return crypto.pbkdf2Sync(pw, salt, 10000, 64, 'sha512').toString('hex') === hash;
}
async function createSession(userId){
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 30*24*3600*1000).toISOString();
  await dbRun('INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)', token, userId, expires);
  return token;
}
async function getSessionUser(token){
  if(!token) return null;
  const s = await dbGet('SELECT user_id, expires_at FROM sessions WHERE token=?', token);
  if(!s || new Date(s.expires_at)<new Date()) return null;
  return dbGet('SELECT id,name,email,role,status,active,personal_id FROM users WHERE id=?', s.user_id);
}
function extractToken(req){
  const a = req.headers['authorization'];
  return a && a.startsWith('Bearer ') ? a.slice(7) : (req.headers['x-vigor-token']||null);
}
async function authUser(req){ return getSessionUser(extractToken(req)); }
async function requireAuth(req){
  const u = await authUser(req);
  if(!u) throw {status:401, message:'Não autenticado.'};
  return u;
}
async function getDefaultPersonalId(){
  const r = await dbGet("SELECT id FROM users WHERE role='personal' LIMIT 1");
  return r ? r.id : null;
}
async function resolvePersonalId(req){
  const u = await authUser(req);
  if(u && u.role==='personal') return u.id;
  if(u && u.role==='aluno') return (await dbGet('SELECT personal_id FROM users WHERE id=?', u.id))?.personal_id;
  return await getDefaultPersonalId(); // modo demo
}

// ── cálculos avaliação ────────────────────────────────────────
function imcLabel(imc){
  if(!imc) return '';
  if(imc<18.5) return 'Abaixo do peso';
  if(imc<25)   return 'Peso normal';
  if(imc<30)   return 'Sobrepeso';
  if(imc<35)   return 'Obesidade I';
  if(imc<40)   return 'Obesidade II';
  return 'Obesidade III';
}
function computeForTipo(tipo, f, protocolo){
  f = f||{}; const out = {};
  if(tipo==='Antropometria'){
    const peso=Number(f.peso)||0, alt=Number(f.altura)||0;
    out.imc = alt ? round1(peso/((alt/100)**2)) : 0;
    out.imcLabel = imcLabel(out.imc);
  } else if(tipo==='Adipometria'){
    const sexo=f.sexo==='M'?'M':'F', idade=Number(f.idade)||0;
    let soma=0, bd=0;
    if(protocolo==='3dobras'){
      const d1=Number(f.dobra1)||0,d2=Number(f.dobra2)||0,d3=Number(f.dobra3)||0;
      soma=d1+d2+d3;
      bd = sexo==='M'
        ? 1.10938 - 0.0008267*soma + 0.0000016*soma**2 - 0.0002574*idade
        : 1.0994921 - 0.0009929*soma + 0.0000023*soma**2 - 0.0001392*idade;
    } else if(protocolo==='5dobras'){
      const d1=Number(f.peitoral)||0,d2=Number(f.abdominal)||0,d3=Number(f.coxa)||0,d4=Number(f.suprailiaca)||0,d5=Number(f.axilar)||0;
      soma=d1+d2+d3+d4+d5;
      bd = sexo==='M'
        ? 1.1099 - 0.0007619*soma + 0.0000023*soma**2 - 0.0001392*idade
        : 1.089733 - 0.0009245*soma + 0.0000025*soma**2 - 0.0000979*idade;
    } else { // 7dobras
      const d1=Number(f.peitoral)||0,d2=Number(f.triceps)||0,d3=Number(f.subescapular)||0,
            d4=Number(f.suprailiaca)||0,d5=Number(f.abdominal)||0,d6=Number(f.coxa)||0,d7=Number(f.axilar)||0;
      soma=d1+d2+d3+d4+d5+d6+d7;
      bd = sexo==='M'
        ? 1.112 - 0.00043499*soma + 0.00000055*soma**2 - 0.00028826*idade
        : 1.097 - 0.00046971*soma + 0.00000056*soma**2 - 0.00012828*idade;
    }
    out.bf = bd ? round1((495/bd)-450) : 0;
    const p=Number(f.peso)||0,alt=Number(f.altura)||0;
    out.imc = alt ? round1(p/((alt/100)**2)) : 0;
  } else if(tipo==='Perimetria'){
    const cint=Number(f.cintura)||0,quad=Number(f.quadril)||0;
    out.rcq = quad ? round2(cint/quad) : 0;
  } else if(tipo==='Bioimpedância'){
    out.bf = Number(f.gordura)||0;
  }
  return out;
}

// ── cálculo de carga sugerida (Brzycki + 80%1RM) ─────────────
function calcSuggestedLoad(carga, reps, rpe){
  const load = parseFloat(String(carga).replace(/[^\d.]/g,''))||0;
  if(!load||!reps) return null;
  const adjReps = reps + (10-(rpe||10))*1.5;
  const denom = 1.0278 - 0.0278 * adjReps;
  if(denom<=0) return null;
  const rm1 = load / denom;
  const suggested = round1(Math.ceil((rm1*0.8)/2.5)*2.5);
  return { rm1: round1(rm1), suggested, unit: String(carga).replace(/[\d.]/g,'').trim()||'kg' };
}

// ── HTTP helpers ──────────────────────────────────────────────
const MIME = {'.html':'text/html;charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.ico':'image/x-icon'};
function sendJson(res,status,obj){
  const body=JSON.stringify(obj);
  res.writeHead(status,{'Content-Type':'application/json;charset=utf-8','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type,Authorization,X-Vigor-Token','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS'});
  res.end(body);
}
function readBody(req){
  return new Promise((resolve,reject)=>{
    let d='';
    req.on('data',c=>d+=c);
    req.on('end',()=>{ try{resolve(d?JSON.parse(d):{});}catch(e){reject(e);} });
    req.on('error',reject);
  });
}
async function audit(actorId,actorRole,action,entity,entityId,detail){
  await dbRun('INSERT INTO audit_log (id,actor_id,actor_role,action,entity,entity_id,detail) VALUES (?,?,?,?,?,?,?)',
    uid('log'),actorId||null,actorRole||null,action,entity,entityId||null,detail?JSON.stringify(detail):null);
}

// ── seed ──────────────────────────────────────────────────────
const MUSCLE_GROUPS = ['Peito','Costas','Ombros','Bíceps','Tríceps','Pernas','Glúteos','Abdômen','Cardio'];
const LIBRARY_SEED = [
  ['Peito','Supino reto com barra','https://www.youtube.com/watch?v=rT7DgCr-3pg'],
  ['Peito','Supino inclinado com halteres','https://www.youtube.com/watch?v=8iPEnn-ltC8'],
  ['Peito','Crucifixo com halteres','https://www.youtube.com/watch?v=eozdVDA78K0'],
  ['Peito','Flexão de braço',''],
  ['Costas','Puxada frente na polia','https://www.youtube.com/watch?v=CAwf7n6Luuc'],
  ['Costas','Remada curvada com barra','https://www.youtube.com/watch?v=FWJR5Ve8bnQ'],
  ['Costas','Remada unilateral com haltere','https://www.youtube.com/watch?v=pYcpY20QaE8'],
  ['Costas','Remada baixa na polia','https://www.youtube.com/watch?v=GZbfZ033f74'],
  ['Ombros','Desenvolvimento com barra','https://www.youtube.com/watch?v=2yjwXTZQDDI'],
  ['Ombros','Elevação lateral com halteres','https://www.youtube.com/watch?v=3VcKaXpzqRo'],
  ['Ombros','Elevação frontal com halteres',''],
  ['Bíceps','Rosca direta com barra','https://www.youtube.com/watch?v=ykJmrZ5v0Oo'],
  ['Bíceps','Rosca alternada com halteres','https://www.youtube.com/watch?v=sAq_ocpRh_I'],
  ['Bíceps','Rosca martelo','https://www.youtube.com/watch?v=zC3nLlEvin4'],
  ['Tríceps','Tríceps corda na polia','https://www.youtube.com/watch?v=kiuVA0gs3EI'],
  ['Tríceps','Tríceps testa com barra','https://www.youtube.com/watch?v=d_KZxkY_0cM'],
  ['Tríceps','Mergulho entre bancos',''],
  ['Pernas','Agachamento livre','https://www.youtube.com/watch?v=ultWZbUMPL8'],
  ['Pernas','Leg press 45°','https://www.youtube.com/watch?v=IZxyjW7MPJQ'],
  ['Pernas','Cadeira extensora','https://www.youtube.com/watch?v=m0FOpMEgero'],
  ['Pernas','Cadeira flexora','https://www.youtube.com/watch?v=1Tq3QdYUuHs'],
  ['Pernas','Stiff com barra','https://www.youtube.com/watch?v=1uDiW5--rAE'],
  ['Pernas','Afundo (lunges)','https://www.youtube.com/watch?v=QOVaHwm-Q6U'],
  ['Glúteos','Elevação pélvica com barra','https://www.youtube.com/watch?v=FNbdgzG64hE'],
  ['Glúteos','Abdução no cabo','https://www.youtube.com/watch?v=hKSLg8RlKRc'],
  ['Glúteos','Agachamento sumô','https://www.youtube.com/watch?v=8Z1OVXKO3e4'],
  ['Abdômen','Abdominal crunch','https://www.youtube.com/watch?v=Xyd_fa5zoEU'],
  ['Abdômen','Prancha isométrica','https://www.youtube.com/watch?v=ASdvN_XEl_c'],
  ['Abdômen','Russian twist','https://www.youtube.com/watch?v=wkD8rjkodUI'],
  ['Cardio','Esteira',''],
  ['Cardio','Bicicleta ergométrica',''],
  ['Cardio','Polichinelo',''],
];

async function seedIfEmpty(){
  const count = (await dbGet('SELECT COUNT(*) as c FROM users')).c;
  if(count>0) return;

  // personal demo
  const {hash,salt} = hashPassword('vigor123');
  const pid = uid('u');
  await dbRun('INSERT INTO users (id,name,email,password_hash,password_salt,whatsapp,role,status,active) VALUES (?,?,?,?,?,?,?,?,1)',
    pid,'Carlos Reis (Demo)','personal@vigor.app',hash,salt,'5511999990000','personal','pro');
  await dbRun('INSERT INTO personal_profiles (user_id,business_name,whatsapp,pix_key,mercadopago_link) VALUES (?,?,?,?,?)',
    pid,'Vigor Personal Training','5511999990000','pix@vigor.app','https://mpago.la/exemplo');

  // biblioteca de exercícios (sistema)
  for(const [mg,name,video] of LIBRARY_SEED){
    await dbRun('INSERT INTO exercise_library (id,personal_id,muscle_group,name,video_url,is_custom) VALUES (?,NULL,?,?,?,0)',
      uid('lib'),mg,name,video||'');
  }

  // catálogo de planos
  const planSeeds = [
    {name:'Plano Mensal',price:'R$ 120,00',duration_days:30,desc:'Prescrição semanal, chat e 1 avaliação/mês'},
    {name:'Plano Trimestral',price:'R$ 330,00',duration_days:90,desc:'Prescrição semanal, chat e avaliações mensais'},
    {name:'Plano Semestral',price:'R$ 600,00',duration_days:180,desc:'Tudo incluso + relatórios detalhados de evolução'},
  ];
  for(const p of planSeeds){
    await dbRun('INSERT INTO plan_catalog (id,personal_id,name,price,duration_days,description) VALUES (?,?,?,?,?,?)',
      uid('cat'),pid,p.name,p.price,p.duration_days,p.desc);
  }

  // alunos de exemplo
  const students = [
    {name:'Marina Souza',email:'marina@exemplo.com',wa:'5511988880001',cpf:'111.111.111-11',birth:'1995-03-15',obj:'Hipertrofia',rest:'Leve dor lombar',status:'pro',active:1,adherence:88,
     plan:{name:'Plano Trimestral',price:'R$ 330,00',validity:'06/09/2026'},
     week:{seg:'A',ter:'rest',qua:'B',qui:'A',sex:'B',sab:'rest',dom:'rest'},
     workouts:{
       A:{name:'Treino A — Superior',ex:[['Supino reto com barra',4,10,'35kg',null,null],['Puxada frente na polia',3,12,'40kg',null,null],['Desenvolvimento com barra',3,10,'14kg',null,null]]},
       B:{name:'Treino B — Pernas',ex:[['Cadeira extensora',3,12,'30kg',null,null],['Stiff com barra',4,10,'40kg',null,null],['Elevação pélvica com barra',3,15,'25kg',null,null]]}
     },
     assessments:[
       {tipo:'Antropometria',protocolo:null,date:'22/01/2026',fields:{peso:'68.4',altura:'165'}},
       {tipo:'Antropometria',protocolo:null,date:'20/06/2026',fields:{peso:'66.9',altura:'165'}}
     ]},
    {name:'Carlos Oliveira',email:'carlos@exemplo.com',wa:'5511988880002',cpf:'222.222.222-22',birth:'1988-07-22',obj:'Perda de peso',rest:'Nenhuma',status:'pro',active:1,adherence:41,
     plan:{name:'Plano Mensal',price:'R$ 120,00',validity:'10/07/2026'},
     week:{seg:'B',ter:'A',qua:'rest',qui:'B',sex:'A',sab:'rest',dom:'rest'},
     workouts:{
       A:{name:'Treino A — Full Body',ex:[['Agachamento livre',4,10,'50kg',null,null],['Remada curvada com barra',3,12,'35kg',null,null]]},
       B:{name:'Treino B — Cardio',ex:[['Esteira',1,1,'20min','Manter FC entre 130-150bpm',null],['Abdominal crunch',3,20,'-',null,null]]}
     },
     assessments:[{tipo:'Antropometria',protocolo:null,date:'01/05/2026',fields:{peso:'82',altura:'178'}}]},
    {name:'Júlia Lima',email:'julia@exemplo.com',wa:'5511988880003',cpf:'333.333.333-33',birth:'2000-11-10',obj:'Condicionamento',rest:'Nenhuma',status:'trial',active:1,adherence:100,
     plan:null,
     week:{seg:'A',ter:'rest',qua:'A',qui:'rest',sex:'A',sab:'rest',dom:'rest'},
     workouts:{A:{name:'Treino A — Condicionamento',ex:[['Polichinelo',3,20,'-',null,null],['Afundo (lunges)',3,12,'-',null,null]]}},
     assessments:[]},
    {name:'Pedro Ramos',email:'pedro@exemplo.com',wa:'5511988880004',cpf:'444.444.444-44',birth:'1990-05-05',obj:'Manutenção',rest:'Nenhuma',status:'pro',active:0,adherence:0,
     plan:{name:'Plano Mensal',price:'R$ 120,00',validity:'01/06/2026'},
     week:{seg:'rest',ter:'rest',qua:'rest',qui:'rest',sex:'rest',sab:'rest',dom:'rest'},
     workouts:{}, assessments:[]}
  ];

  for(const s of students){
    const {hash:h2,salt:s2} = hashPassword('aluno123');
    const sid = uid('u');
    const initials = s.name.split(' ').map(p=>p[0]).slice(0,2).join('').toUpperCase();
    await dbRun('INSERT INTO users (id,name,email,password_hash,password_salt,whatsapp,cpf,birthdate,role,status,active,personal_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      sid,s.name,s.email,h2,s2,s.wa,s.cpf,s.birth,'aluno',s.status,s.active,pid);
    await dbRun('INSERT INTO student_profiles (user_id,objetivo,restricao,anamnese_date,adherence,initials) VALUES (?,?,?,?,?,?)',
      sid,s.obj,s.rest,'—',s.adherence,initials);
    if(s.plan){
      await dbRun('INSERT INTO plans (id,student_id,name,price,validity) VALUES (?,?,?,?,?)',
        uid('plan'),sid,s.plan.name,s.plan.price,s.plan.validity);
    }
    for(const d of Object.keys(s.week)){
      await dbRun('INSERT INTO weekly_plan (student_id,day_key,workout_key) VALUES (?,?,?)', sid,d,s.week[d]);
    }
    for(const key of Object.keys(s.workouts)){
      const w = s.workouts[key];
      const wid = uid('w');
      await dbRun('INSERT INTO workouts (id,student_id,workout_key,name) VALUES (?,?,?,?)', wid,sid,key,w.name);
      let idx=0;
      for(const [ename,ser,reps,carga,notes,tip] of w.ex){
        const libRow = await dbGet('SELECT id FROM exercise_library WHERE name=? LIMIT 1', ename);
        await dbRun('INSERT INTO exercises (id,workout_id,library_id,name,series,reps,carga,done,position,notes,tip) VALUES (?,?,?,?,?,?,?,0,?,?,?)',
          uid('ex'),wid,libRow?libRow.id:null,ename,ser,reps,carga,idx,notes||null,tip||null);
        idx++;
      }
    }
    for(const a of s.assessments){
      const computed = computeForTipo(a.tipo,a.fields,a.protocolo);
      await dbRun('INSERT INTO assessments (id,student_id,tipo,protocolo,date,fields_json,computed_json,created_by) VALUES (?,?,?,?,?,?,?,?)',
        uid('ass'),sid,a.tipo,a.protocolo||null,a.date,JSON.stringify(a.fields),JSON.stringify(computed),pid);
    }
  }

  // mensagens exemplo
  const marina = await dbGet("SELECT id FROM users WHERE name='Marina Souza'");
  if(marina){
    const seedMsgs = [
      ['aluno','Professor, terminei o treino B mas senti dor no joelho na cadeira extensora.'],
      ['personal','Entendido! Vou ajustar a carga. Como está a dor agora, de 0 a 10?'],
      ['aluno','Está em 2, bem leve.']
    ];
    for(const [from,text] of seedMsgs){
      await dbRun('INSERT INTO messages (id,student_id,from_role,text) VALUES (?,?,?,?)', uid('msg'),marina.id,from,text);
    }
  }

  // alertas e sugestões IA
  const allStudents = await dbAll("SELECT id,name FROM users WHERE role='aluno'");
  const byName = {}; allStudents.forEach(u=>byName[u.name]=u.id);
  await dbRun('INSERT INTO alerts (id,student_id,type,text) VALUES (?,?,?,?)', uid('al'),byName['Marina Souza'],'avaliacao_vencendo','Avaliação de Marina Souza vence em 3 dias.');
  await dbRun('INSERT INTO alerts (id,student_id,type,text) VALUES (?,?,?,?)', uid('al'),byName['Carlos Oliveira'],'sem_treino','Carlos não registra treino há 5 dias.');
  await dbRun('INSERT INTO ai_suggestions (id,student_id,text) VALUES (?,?,?)', uid('sug'),byName['Marina Souza'],'Marina evoluiu a carga de stiff em 3 semanas. Sugiro progredir para 42,5kg no Treino B.');
  await dbRun('INSERT INTO ai_suggestions (id,student_id,text) VALUES (?,?,?)', uid('sug'),byName['Carlos Oliveira'],'Carlos está há 5 dias sem treinar. Sugiro reduzir o volume e enviar check-in.');
  await dbRun('INSERT INTO ai_suggestions (id,student_id,text) VALUES (?,?,?)', uid('sug'),byName['Júlia Lima'],'Júlia concluiu a avaliação inicial. Perfil compatível com "Condicionamento — Iniciante 3x".');

  await audit(pid,'system','seed','database',null,{message:'Banco inicializado com dados de demonstração.'});
  console.log('Banco inicializado com seed. Login demo: personal@vigor.app / vigor123 | alunos: marina@exemplo.com / aluno123');
}
// seedIfEmpty() é chamado no bootstrap assíncrono no final do arquivo.

// ── serialização de estado ────────────────────────────────────
async function serializeFullState(personalId){
  const studentsRows = await dbAll(`
    SELECT u.id,u.name,u.email,u.whatsapp,u.cpf,u.birthdate,u.status,u.active,
           p.objetivo,p.restricao,p.anamnese_date,p.adherence,p.initials
    FROM users u LEFT JOIN student_profiles p ON p.user_id=u.id
    WHERE u.role='aluno' AND u.personal_id=? ORDER BY u.created_at ASC`, personalId);

  const students={},weeklyPlan={},workoutDefs={},assessments={},messages={},aiSuggestions={};
  for(const s of studentsRows){
    const plan = await dbGet('SELECT name,price,validity FROM plans WHERE student_id=? ORDER BY created_at DESC LIMIT 1', s.id);
    students[s.id] = {id:s.id,name:s.name,email:s.email,whatsapp:s.whatsapp,cpf:s.cpf,birthdate:s.birthdate,
      initials:s.initials,active:!!s.active,status:s.status,adherence:s.adherence,
      objetivo:s.objetivo,restricao:s.restricao,anamnese:s.anamnese_date,
      plan:plan?{name:plan.name,price:plan.price,validity:plan.validity}:null};
    const wp = await dbAll('SELECT day_key,workout_key FROM weekly_plan WHERE student_id=?', s.id);
    weeklyPlan[s.id]={};
    wp.forEach(r=>weeklyPlan[s.id][r.day_key]=r.workout_key);
    const ws = await dbAll('SELECT id,workout_key,name FROM workouts WHERE student_id=?', s.id);
    workoutDefs[s.id]={};
    for(const w of ws){
      const exs = await dbAll('SELECT id,name,series,reps,carga,done,notes,tip,library_id FROM exercises WHERE workout_id=? ORDER BY position ASC', w.id);
      workoutDefs[s.id][w.workout_key]={name:w.name,exercises:exs.map(e=>({id:e.id,name:e.name,series:e.series,reps:e.reps,carga:e.carga,done:!!e.done,notes:e.notes,tip:e.tip,library_id:e.library_id}))};
    }
    const asg = await dbAll('SELECT id,tipo,protocolo,date,fields_json,computed_json FROM assessments WHERE student_id=? ORDER BY created_at ASC', s.id);
    assessments[s.id]=asg.map(a=>({id:a.id,tipo:a.tipo,protocolo:a.protocolo,date:a.date,fields:JSON.parse(a.fields_json),computed:JSON.parse(a.computed_json)}));
    const msgs = await dbAll('SELECT from_role,text,created_at FROM messages WHERE student_id=? ORDER BY created_at ASC', s.id);
    messages[s.id]=msgs.map(m=>({from:m.from_role,text:m.text}));
    const sugs = await dbAll('SELECT id,text,exercise_id,suggested_load FROM ai_suggestions WHERE student_id=? ORDER BY created_at ASC', s.id);
    aiSuggestions[s.id]=sugs.map(g=>({id:g.id,text:g.text,exercise_id:g.exercise_id,suggested_load:g.suggested_load}));
  }
  const alerts = await dbAll('SELECT a.id,a.student_id,a.type,a.text FROM alerts a JOIN users u ON u.id=a.student_id WHERE u.personal_id=? ORDER BY a.created_at ASC', personalId);
  const planCatalog = await dbAll('SELECT id,name,price,duration_days,description FROM plan_catalog WHERE personal_id=? ORDER BY created_at ASC', personalId);
  const pp = (await dbGet('SELECT business_name,whatsapp,pix_key,mercadopago_link FROM personal_profiles WHERE user_id=?', personalId))||{};
  const lib = await dbAll('SELECT id,muscle_group,name,video_url,notes,is_custom,personal_id FROM exercise_library WHERE personal_id IS NULL OR personal_id=? ORDER BY muscle_group,name', personalId);
  return {students,weeklyPlan,workoutDefs,assessments,messages,aiSuggestions,alerts,planCatalog,personalProfile:pp,exerciseLibrary:lib};
}

// ── roteador ──────────────────────────────────────────────────
const routes=[];
function route(method,pattern,handler){
  const keys=[];
  const regex=new RegExp('^'+pattern.replace(/:[^/]+/g,m=>{keys.push(m.slice(1));return '([^/]+)'})+'$');
  routes.push({method,regex,keys,handler});
}

// ── AUTH ─────────────────────────────────────────────────────
route('POST','/api/auth/register-personal',async(req,res)=>{
  const b=await readBody(req);
  if(!b.name||!b.email||!b.password) return sendJson(res,400,{error:'Nome, e-mail e senha são obrigatórios.'});
  if(await dbGet('SELECT id FROM users WHERE email=?', b.email)) return sendJson(res,409,{error:'E-mail já cadastrado.'});
  const {hash,salt}=hashPassword(b.password);
  const uid2=uid('u');
  await dbRun('INSERT INTO users (id,name,email,password_hash,password_salt,whatsapp,role,status,active) VALUES (?,?,?,?,?,?,?,?,1)', uid2,b.name.trim(),b.email.toLowerCase().trim(),hash,salt,b.whatsapp||null,'personal','pro');
  await dbRun('INSERT INTO personal_profiles (user_id,business_name,whatsapp,pix_key,mercadopago_link) VALUES (?,?,?,?,?)', uid2,b.businessName||b.name,b.whatsapp||'','','');
  const token=await createSession(uid2);
  await audit(uid2,'personal','register','user',uid2,{email:b.email});
  sendJson(res,201,{token,user:{id:uid2,name:b.name,email:b.email,role:'personal'}});
});

route('POST','/api/auth/register-student',async(req,res)=>{
  const b=await readBody(req);
  const requiredFields=['name','email','password','whatsapp','birthdate'];
  for(const f of requiredFields) if(!b[f]) return sendJson(res,400,{error:`Campo obrigatório: ${f}`});
  if(await dbGet('SELECT id FROM users WHERE email=?', b.email)) return sendJson(res,409,{error:'E-mail já cadastrado.'});
  // student auto-register: linked to first personal in system (ou via token de convite no futuro)
  const personalId = b.personalId || await getDefaultPersonalId();
  if(!personalId) return sendJson(res,400,{error:'Nenhum personal encontrado. Aguarde o convite do seu personal trainer.'});
  const {hash,salt}=hashPassword(b.password);
  const sid=uid('u');
  const initials=b.name.trim().split(/\s+/).map(p=>p[0]).slice(0,2).join('').toUpperCase();
  await dbRun('INSERT INTO users (id,name,email,password_hash,password_salt,whatsapp,cpf,birthdate,role,status,active,personal_id) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)', sid,b.name.trim(),b.email.toLowerCase().trim(),hash,salt,b.whatsapp,b.cpf||null,b.birthdate,'aluno','trial',personalId);
  await dbRun('INSERT INTO student_profiles (user_id,objetivo,restricao,anamnese_date,adherence,initials) VALUES (?,?,?,?,?,?)', sid,'A definir','Nenhuma','—',0,initials);
  for(const d of ['seg','ter','qua','qui','sex','sab','dom']) await dbRun("INSERT INTO weekly_plan (student_id,day_key,workout_key) VALUES (?,?,'rest')", sid,d);
  const token=await createSession(sid);
  await audit(sid,'aluno','register','user',sid,{email:b.email});
  sendJson(res,201,{token,user:{id:sid,name:b.name,email:b.email,role:'aluno',status:'trial'}});
});

route('POST','/api/auth/login',async(req,res)=>{
  const b=await readBody(req);
  if(!b.email||!b.password) return sendJson(res,400,{error:'E-mail e senha são obrigatórios.'});
  const u=await dbGet('SELECT id,name,email,password_hash,password_salt,role,status,active,personal_id FROM users WHERE email=?', b.email.toLowerCase().trim());
  if(!u||!verifyPassword(b.password,u.password_hash,u.password_salt)) return sendJson(res,401,{error:'E-mail ou senha incorretos.'});
  if(!u.active) return sendJson(res,403,{error:'Sua conta está suspensa. Entre em contato com seu personal trainer.'});
  const token=await createSession(u.id);
  await audit(u.id,u.role,'login','user',u.id,null);
  sendJson(res,200,{token,user:{id:u.id,name:u.name,email:u.email,role:u.role,status:u.status,personal_id:u.personal_id}});
});

route('POST','/api/auth/logout',async(req,res)=>{
  const token=extractToken(req);
  if(token) await dbRun('DELETE FROM sessions WHERE token=?', token);
  sendJson(res,200,{ok:true});
});

route('GET','/api/auth/me',async(req,res)=>{
  const u=await authUser(req);
  if(!u) return sendJson(res,401,{error:'Não autenticado.'});
  sendJson(res,200,{user:u});
});

route('POST','/api/auth/forgot-password',async(req,res)=>{
  const b=await readBody(req);
  const u=await dbGet('SELECT id,name,email FROM users WHERE email=?', (b.email||'').toLowerCase().trim());
  if(!u) return sendJson(res,200,{ok:true,message:'Se o e-mail existir, um link foi gerado.'});
  const token=crypto.randomBytes(24).toString('hex');
  const expires=new Date(Date.now()+2*3600*1000).toISOString();
  await dbRun('INSERT INTO password_reset_tokens (token,user_id,expires_at) VALUES (?,?,?)', token,u.id,expires);
  const resetUrl=`/reset-password?token=${token}`;
  // sem SMTP configurado: retornar o link para o personal enviar manualmente
  sendJson(res,200,{ok:true,resetUrl,message:`Link gerado (válido 2h). Envie para o aluno: ${resetUrl}`});
});

route('POST','/api/auth/reset-password',async(req,res)=>{
  const b=await readBody(req);
  if(!b.token||!b.password) return sendJson(res,400,{error:'Token e nova senha são obrigatórios.'});
  const t=await dbGet('SELECT user_id,expires_at,used FROM password_reset_tokens WHERE token=?', b.token);
  if(!t||t.used||new Date(t.expires_at)<new Date()) return sendJson(res,400,{error:'Link inválido ou expirado.'});
  const {hash,salt}=hashPassword(b.password);
  await dbRun('UPDATE users SET password_hash=?,password_salt=? WHERE id=?', hash,salt,t.user_id);
  await dbRun('UPDATE password_reset_tokens SET used=1 WHERE token=?', b.token);
  sendJson(res,200,{ok:true});
});

// ── PERSONAL PROFILE ─────────────────────────────────────────
route('GET','/api/personal/profile',async(req,res)=>{
  const pid=await resolvePersonalId(req);
  const pp=await dbGet('SELECT * FROM personal_profiles WHERE user_id=?', pid)||{};
  const u=await dbGet('SELECT name,email,whatsapp FROM users WHERE id=?', pid)||{};
  sendJson(res,200,{...pp,...u});
});
route('PUT','/api/personal/profile',async(req,res)=>{
  const b=await readBody(req);
  const pid=await resolvePersonalId(req);
  await dbRun('INSERT INTO personal_profiles (user_id,business_name,whatsapp,pix_key,mercadopago_link) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET business_name=excluded.business_name,whatsapp=excluded.whatsapp,pix_key=excluded.pix_key,mercadopago_link=excluded.mercadopago_link', pid,b.businessName||'',b.whatsapp||'',b.pixKey||'',b.mercadopagoLink||'');
  if(b.whatsapp) await dbRun('UPDATE users SET whatsapp=? WHERE id=?', b.whatsapp,pid);
  sendJson(res,200,{ok:true});
});

// ── ESTADO COMPLETO ───────────────────────────────────────────
route('GET','/api/state',async(req,res)=>{
  const pid=await resolvePersonalId(req);
  if(!pid) return sendJson(res,200,{students:{},weeklyPlan:{},workoutDefs:{},assessments:{},messages:{},aiSuggestions:{},alerts:[],planCatalog:[],personalProfile:{},exerciseLibrary:[]});
  sendJson(res,200,await serializeFullState(pid));
});

// ── ALUNOS ────────────────────────────────────────────────────
route('POST','/api/students',async(req,res)=>{
  const b=await readBody(req);
  const pid=await resolvePersonalId(req);
  if(!b.name||!b.email) return sendJson(res,400,{error:'Nome e e-mail são obrigatórios.'});
  if(await dbGet('SELECT id FROM users WHERE email=?', b.email)) return sendJson(res,409,{error:'E-mail já cadastrado.'});
  const {hash,salt}=hashPassword(b.password||'vigor123');
  const sid=uid('u');
  const initials=b.name.trim().split(/\s+/).map(p=>p[0]).slice(0,2).join('').toUpperCase();
  await dbRun('INSERT INTO users (id,name,email,password_hash,password_salt,whatsapp,cpf,birthdate,role,status,active,personal_id) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)', sid,b.name.trim(),b.email.toLowerCase().trim(),hash,salt,b.whatsapp||null,b.cpf||null,b.birthdate||null,'aluno','trial',pid);
  await dbRun('INSERT INTO student_profiles (user_id,objetivo,restricao,anamnese_date,adherence,initials) VALUES (?,?,?,?,?,?)', sid,b.objetivo||'A definir',b.restricao||'Nenhuma','—',0,initials);
  for(const d of ['seg','ter','qua','qui','sex','sab','dom']) await dbRun("INSERT INTO weekly_plan (student_id,day_key,workout_key) VALUES (?,?,'rest')", sid,d);
  await audit(pid,'personal','create','student',sid,{name:b.name});
  sendJson(res,201,{id:sid,tempPassword:b.password||'vigor123'});
});

route('PUT','/api/students/:id/access',async(req,res,p)=>{
  const b=await readBody(req);
  const pid=await resolvePersonalId(req);
  await dbRun('UPDATE users SET active=? WHERE id=? AND personal_id=?', b.active?1:0,p.id,pid);
  await audit(pid,'personal',b.active?'activate':'deactivate','student',p.id,null);
  sendJson(res,200,{ok:true});
});

route('PUT','/api/students/:id/plan',async(req,res,p)=>{
  const b=await readBody(req);
  const pid=await resolvePersonalId(req);
  await dbRun('INSERT INTO plans (id,student_id,catalog_id,name,price,validity) VALUES (?,?,?,?,?,?)', uid('plan'),p.id,b.catalogId||null,b.name||'Plano',b.price||'',b.validity||'');
  await dbRun("UPDATE users SET status='pro' WHERE id=?", p.id);
  await audit(pid,'personal','assign_plan','student',p.id,b);
  sendJson(res,200,{ok:true});
});

route('GET','/api/students/:id/access-data',async(req,res,p)=>{
  const pid=await resolvePersonalId(req);
  const u=await dbGet('SELECT name,email,whatsapp FROM users WHERE id=? AND personal_id=?', p.id,pid);
  if(!u) return sendJson(res,404,{error:'Aluno não encontrado.'});
  sendJson(res,200,{name:u.name,email:u.email,whatsapp:u.whatsapp,loginUrl:'/login'});
});

// ── PLANOS (CATÁLOGO) ─────────────────────────────────────────
route('GET','/api/plan-catalog',async(req,res)=>{
  const pid=await resolvePersonalId(req);
  sendJson(res,200,await dbAll('SELECT * FROM plan_catalog WHERE personal_id=? ORDER BY created_at', pid));
});
route('POST','/api/plan-catalog',async(req,res)=>{
  const b=await readBody(req);
  const pid=await resolvePersonalId(req);
  if(!b.name) return sendJson(res,400,{error:'Nome é obrigatório.'});
  const id=uid('cat');
  await dbRun('INSERT INTO plan_catalog (id,personal_id,name,price,duration_days,description) VALUES (?,?,?,?,?,?)', id,pid,b.name,b.price||'',b.duration_days||30,b.description||'');
  sendJson(res,201,{id});
});
route('PUT','/api/plan-catalog/:id',async(req,res,p)=>{
  const b=await readBody(req);
  await dbRun('UPDATE plan_catalog SET name=COALESCE(?,name),price=COALESCE(?,price),duration_days=COALESCE(?,duration_days),description=COALESCE(?,description) WHERE id=?', b.name||null,b.price||null,b.duration_days||null,b.description||null,p.id);
  sendJson(res,200,{ok:true});
});
route('DELETE','/api/plan-catalog/:id',async(req,res,p)=>{
  await dbRun('DELETE FROM plan_catalog WHERE id=?', p.id);
  sendJson(res,200,{ok:true});
});

// ── BIBLIOTECA DE EXERCÍCIOS ──────────────────────────────────
route('GET','/api/exercise-library',async(req,res)=>{
  const pid=await resolvePersonalId(req);
  sendJson(res,200,await dbAll('SELECT * FROM exercise_library WHERE personal_id IS NULL OR personal_id=? ORDER BY muscle_group,name', pid));
});
route('POST','/api/exercise-library',async(req,res)=>{
  const b=await readBody(req);
  const pid=await resolvePersonalId(req);
  if(!b.name||!b.muscleGroup) return sendJson(res,400,{error:'Nome e grupo muscular são obrigatórios.'});
  const id=uid('lib');
  await dbRun('INSERT INTO exercise_library (id,personal_id,muscle_group,name,video_url,notes,is_custom) VALUES (?,?,?,?,?,?,1)', id,pid,b.muscleGroup,b.name,b.videoUrl||'',b.notes||'');
  sendJson(res,201,{id});
});
route('PUT','/api/exercise-library/:id',async(req,res,p)=>{
  const b=await readBody(req);
  await dbRun('UPDATE exercise_library SET name=COALESCE(?,name),video_url=COALESCE(?,video_url),notes=COALESCE(?,notes) WHERE id=?', b.name||null,b.videoUrl??null,b.notes??null,p.id);
  sendJson(res,200,{ok:true});
});
route('DELETE','/api/exercise-library/:id',async(req,res,p)=>{
  await dbRun('DELETE FROM exercise_library WHERE id=?', p.id);
  sendJson(res,200,{ok:true});
});

// ── TREINOS ───────────────────────────────────────────────────
route('PUT','/api/students/:id/weekly-plan/:day',async(req,res,p)=>{
  const b=await readBody(req);
  await dbRun('INSERT INTO weekly_plan (student_id,day_key,workout_key) VALUES (?,?,?) ON CONFLICT(student_id,day_key) DO UPDATE SET workout_key=excluded.workout_key', p.id,p.day,b.workoutKey);
  sendJson(res,200,{ok:true});
});
route('POST','/api/students/:id/workouts',async(req,res,p)=>{
  const b=await readBody(req);
  const pid=await resolvePersonalId(req);
  if(!b.name) return sendJson(res,400,{error:'Nome do treino é obrigatório.'});
  const existingKey = await dbGet('SELECT workout_key FROM workouts WHERE student_id=? AND name=?', p.id,b.name);
  const key=b.key||('W'+uid('').slice(0,6));
  const wid=uid('w');
  await dbRun('INSERT INTO workouts (id,student_id,workout_key,name) VALUES (?,?,?,?)', wid,p.id,key,b.name);
  const exList = b.exercises||[];
  for(let idx=0; idx<exList.length; idx++){
    const e = exList[idx];
    await dbRun('INSERT INTO exercises (id,workout_id,library_id,name,series,reps,carga,done,position,notes,tip) VALUES (?,?,?,?,?,?,?,0,?,?,?)', uid('ex'),wid,e.library_id||null,e.name,e.series||3,e.reps||10,e.carga||'-',idx,e.notes||null,e.tip||null);
  }
  await audit(pid,'personal','create','workout',wid,{name:b.name});
  sendJson(res,201,{id:wid,key});
});
route('DELETE','/api/workouts/:studentId/:workoutKey',async(req,res,p)=>{
  const w=await dbGet('SELECT id FROM workouts WHERE student_id=? AND workout_key=?', p.studentId,p.workoutKey);
  if(!w) return sendJson(res,404,{error:'Treino não encontrado.'});
  await dbRun('DELETE FROM workouts WHERE id=?', w.id);
  await dbRun("UPDATE weekly_plan SET workout_key='rest' WHERE student_id=? AND workout_key=?", p.studentId,p.workoutKey);
  sendJson(res,200,{ok:true});
});
route('POST','/api/workouts/:studentId/:workoutKey/exercises',async(req,res,p)=>{
  const b=await readBody(req);
  const w=await dbGet('SELECT id FROM workouts WHERE student_id=? AND workout_key=?', p.studentId,p.workoutKey);
  if(!w) return sendJson(res,404,{error:'Treino não encontrado.'});
  const count=(await dbGet('SELECT COUNT(*) as c FROM exercises WHERE workout_id=?', w.id)).c;
  const exid=uid('ex');
  await dbRun('INSERT INTO exercises (id,workout_id,library_id,name,series,reps,carga,done,position,notes,tip) VALUES (?,?,?,?,?,?,?,0,?,?,?)', exid,w.id,b.library_id||null,b.name||'Exercício',b.series||3,b.reps||10,b.carga||'-',count,b.notes||null,b.tip||null);
  sendJson(res,201,{id:exid});
});
route('PUT','/api/exercises/:id',async(req,res,p)=>{
  const b=await readBody(req);
  const fields=[];const vals=[];
  if(b.carga!==undefined){fields.push('carga=?');vals.push(b.carga);}
  if(b.series!==undefined){fields.push('series=?');vals.push(b.series);}
  if(b.reps!==undefined){fields.push('reps=?');vals.push(b.reps);}
  if(b.done!==undefined){fields.push('done=?');vals.push(b.done?1:0);}
  if(b.notes!==undefined){fields.push('notes=?');vals.push(b.notes);}
  if(b.tip!==undefined){fields.push('tip=?');vals.push(b.tip);}
  if(b.name!==undefined){fields.push('name=?');vals.push(b.name);}
  if(fields.length){vals.push(p.id);await dbRun(`UPDATE exercises SET ${fields.join(',')} WHERE id=?`, ...vals);}
  sendJson(res,200,{ok:true});
});
route('DELETE','/api/exercises/:id',async(req,res,p)=>{
  await dbRun('DELETE FROM exercises WHERE id=?', p.id);
  sendJson(res,200,{ok:true});
});

// ── RPE / LOGS DE EXECUÇÃO ────────────────────────────────────
route('POST','/api/exercise-logs',async(req,res)=>{
  const b=await readBody(req);
  if(!b.exerciseId||!b.studentId) return sendJson(res,400,{error:'Campos obrigatórios faltando.'});
  await dbRun('INSERT INTO exercise_logs (id,exercise_id,student_id,date,carga_usada,reps_realizadas,rpe) VALUES (?,?,?,?,?,?,?)', uid('log'),b.exerciseId,b.studentId,b.date||now().slice(0,10),b.carga||null,b.reps||null,b.rpe||null);
  if(b.rpe!==undefined) await dbRun('UPDATE exercises SET done=1 WHERE id=?', b.exerciseId);
  sendJson(res,201,{ok:true});
});
route('POST','/api/students/:id/complete-today',async(req,res,p)=>{
  await dbRun('UPDATE student_profiles SET adherence=MIN(100,adherence+3) WHERE user_id=?', p.id);
  await dbRun("DELETE FROM alerts WHERE student_id=? AND type='sem_treino'", p.id);
  sendJson(res,200,{ok:true});
});

// ── SUGESTÃO DE CARGA PELA IA (RPE + 10RM) ───────────────────
route('POST','/api/students/:id/suggest-loads',async(req,res,p)=>{
  const pid=await resolvePersonalId(req);
  // para cada exercício com log de RPE, calcular carga sugerida
  const logs=await dbAll(`
    SELECT el.exercise_id,el.carga_usada,el.reps_realizadas,el.rpe,e.name,e.carga as current_carga
    FROM exercise_logs el
    JOIN exercises e ON e.id=el.exercise_id
    WHERE el.student_id=? AND el.rpe IS NOT NULL
    ORDER BY el.created_at DESC`, p.id);
  const seen=new Set();
  const suggestions=[];
  for(const log of logs){
    if(seen.has(log.exercise_id)) continue;
    seen.add(log.exercise_id);
    const calc=calcSuggestedLoad(log.carga_usada||log.current_carga,log.reps_realizadas||10,log.rpe);
    if(!calc) continue;
    if(Math.abs(parseFloat(String(log.current_carga).replace(/[^\d.]/g,''))-calc.suggested)>0.5){
      const text=`${log.name}: RPE ${log.rpe}/10 com ${log.carga_usada||log.current_carga}. 1RM estimado: ${calc.rm1}${calc.unit}. Carga sugerida (80% 1RM): ${calc.suggested}${calc.unit}`;
      const sugId=uid('sug');
      await dbRun('INSERT INTO ai_suggestions (id,student_id,exercise_id,text,suggested_load) VALUES (?,?,?,?,?)', sugId,p.id,log.exercise_id,text,calc.suggested);
      suggestions.push({exercise_id:log.exercise_id,text,suggested_load:calc.suggested,unit:calc.unit});
    }
  }
  sendJson(res,200,{suggestions,count:suggestions.length});
});

route('POST','/api/exercises/:id/apply-suggestion',async(req,res,p)=>{
  const b=await readBody(req);
  await dbRun('UPDATE exercises SET carga=? WHERE id=?', b.carga,p.id);
  if(b.suggestionId) await dbRun('DELETE FROM ai_suggestions WHERE id=?', b.suggestionId);
  sendJson(res,200,{ok:true});
});

// ── AVALIAÇÕES ────────────────────────────────────────────────
route('POST','/api/students/:id/assessments',async(req,res,p)=>{
  const b=await readBody(req);
  const actorRole=b.actorRole||'personal';
  const pid=await resolvePersonalId(req);
  const computed=computeForTipo(b.tipo,b.fields,b.protocolo);
  const aid=uid('ass');
  await dbRun('INSERT INTO assessments (id,student_id,tipo,protocolo,date,fields_json,computed_json,created_by) VALUES (?,?,?,?,?,?,?,?)', aid,p.id,b.tipo,b.protocolo||null,b.date||'—',JSON.stringify(b.fields||{}),JSON.stringify(computed),actorRole==='personal'?pid:p.id);
  if(actorRole==='personal') await dbRun("DELETE FROM alerts WHERE student_id=? AND type='avaliacao_vencendo'", p.id);
  sendJson(res,201,{id:aid,computed});
});
route('PUT','/api/assessments/:id',async(req,res,p)=>{
  const b=await readBody(req);
  const row=await dbGet('SELECT tipo,protocolo FROM assessments WHERE id=?', p.id);
  if(!row) return sendJson(res,404,{error:'Avaliação não encontrada.'});
  const computed=computeForTipo(row.tipo,b.fields,row.protocolo);
  await dbRun('UPDATE assessments SET fields_json=?,computed_json=?,date=COALESCE(?,date) WHERE id=?', JSON.stringify(b.fields||{}),JSON.stringify(computed),b.date||null,p.id);
  await audit(null,'personal','update','assessment',p.id,{fields:b.fields});
  sendJson(res,200,{computed});
});
route('DELETE','/api/assessments/:id',async(req,res,p)=>{
  await dbRun('DELETE FROM assessments WHERE id=?', p.id);
  await audit(null,'personal','delete','assessment',p.id,null);
  sendJson(res,200,{ok:true});
});

// ── MENSAGENS / ALERTAS / IA ──────────────────────────────────
route('POST','/api/students/:id/messages',async(req,res,p)=>{
  const b=await readBody(req);
  if(!b.text||!b.text.trim()) return sendJson(res,400,{error:'Mensagem vazia.'});
  await dbRun('INSERT INTO messages (id,student_id,from_role,text) VALUES (?,?,?,?)', uid('msg'),p.id,b.from,b.text.trim());
  sendJson(res,201,{ok:true});
});
route('DELETE','/api/alerts/:id',async(req,res,p)=>{
  await dbRun('DELETE FROM alerts WHERE id=?', p.id);
  sendJson(res,200,{ok:true});
});
route('POST','/api/students/:id/alerts',async(req,res,p)=>{
  const b=await readBody(req);
  const aid=uid('al');
  await dbRun('INSERT INTO alerts (id,student_id,type,text) VALUES (?,?,?,?)', aid,p.id,b.type||'geral',b.text);
  sendJson(res,201,{id:aid});
});
route('DELETE','/api/students/:id/alerts/by-type/:type',async(req,res,p)=>{
  await dbRun('DELETE FROM alerts WHERE student_id=? AND type=?', p.id,p.type);
  sendJson(res,200,{ok:true});
});
route('DELETE','/api/ai-suggestions/:id',async(req,res,p)=>{
  await dbRun('DELETE FROM ai_suggestions WHERE id=?', p.id);
  sendJson(res,200,{ok:true});
});

// ── IA: COMANDO LIVRE ─────────────────────────────────────────
route('POST','/api/ai-command',async(req,res)=>{
  const b=await readBody(req);
  const pid=await resolvePersonalId(req);
  const cmd=(b.command||'').trim();
  if(!cmd) return sendJson(res,400,{ok:false,msg:'Comando vazio.'});
  const names=(await dbAll("SELECT name FROM users WHERE role='aluno' AND personal_id=?", pid)).map(s=>s.name).join(', ');
  const instructions=`Você é o assistente IA do app VIGOR, usado por um personal trainer. Responda SOMENTE com JSON sem markdown. Alunos: ${names}. Ações permitidas: {"action":"toggle_access","student":"<nome>","active":bool} {"action":"assign_plan","student":"<nome>","planName":"<nome>","price":"<texto>","validity":"<dd/mm/aaaa>"} {"action":"create_student","name":"<nome>"} {"action":"set_day_workout","student":"<nome>","day":"seg|ter|qua|qui|sex|sab|dom","workout":"A|B|rest"} {"action":"send_message","student":"<nome>","text":"<mensagem>"} {"action":"unknown","message":"<explicação>"}. Comando: "${cmd}"`;
  let parsed;
  try{
    const apiRes=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:300,messages:[{role:'user',content:instructions}]})});
    const data=await apiRes.json();
    let text=(data.content||[]).map(b=>b.text||'').join('').replace(/```json|```/g,'').trim();
    parsed=JSON.parse(text);
  }catch(err){return sendJson(res,200,{ok:false,msg:'Não foi possível conectar ao assistente de IA ('+err.message+').'});}
  async function resolve(name){
    const f=await dbGet("SELECT id,name FROM users WHERE role='aluno' AND personal_id=? AND name LIKE ? COLLATE NOCASE LIMIT 1", pid,'%'+(name||'').trim()+'%');
    return f?f.id:null;
  }
  try{
    if(parsed.action==='toggle_access'){const sid=await resolve(parsed.student);if(!sid)return sendJson(res,200,{ok:false,msg:'Aluno não encontrado.'});await dbRun('UPDATE users SET active=? WHERE id=?', parsed.active?1:0,sid);return sendJson(res,200,{ok:true,msg:'Acesso atualizado.'});}
    if(parsed.action==='assign_plan'){const sid=await resolve(parsed.student);if(!sid)return sendJson(res,200,{ok:false,msg:'Aluno não encontrado.'});await dbRun('INSERT INTO plans (id,student_id,name,price,validity) VALUES (?,?,?,?,?)', uid('plan'),sid,parsed.planName||'Plano',parsed.price||'',parsed.validity||'');await dbRun("UPDATE users SET status='pro' WHERE id=?", sid);return sendJson(res,200,{ok:true,msg:'Plano atribuído.'});}
    if(parsed.action==='create_student'){if(!parsed.name)return sendJson(res,200,{ok:false,msg:'Nome não informado.'});const{hash,salt}=hashPassword('vigor123');const sid=uid('u');const init=parsed.name.trim().split(/\s+/).map(p=>p[0]).slice(0,2).join('').toUpperCase();await dbRun('INSERT INTO users (id,name,email,password_hash,password_salt,role,status,active,personal_id) VALUES (?,?,?,?,?,?,?,1,?)', sid,parsed.name,uid('e')+'@exemplo.com',hash,salt,'aluno','trial',pid);await dbRun('INSERT INTO student_profiles (user_id,objetivo,restricao,anamnese_date,adherence,initials) VALUES (?,?,?,?,?,?)', sid,'A definir','Nenhuma','—',0,init);for(const d of ['seg','ter','qua','qui','sex','sab','dom']) await dbRun("INSERT INTO weekly_plan (student_id,day_key,workout_key) VALUES (?,?,'rest')", sid,d);return sendJson(res,200,{ok:true,msg:`Aluno "${parsed.name}" criado.`});}
    if(parsed.action==='set_day_workout'){const sid=await resolve(parsed.student);if(!sid)return sendJson(res,200,{ok:false,msg:'Aluno não encontrado.'});await dbRun('INSERT INTO weekly_plan (student_id,day_key,workout_key) VALUES (?,?,?) ON CONFLICT(student_id,day_key) DO UPDATE SET workout_key=excluded.workout_key', sid,parsed.day,parsed.workout);return sendJson(res,200,{ok:true,msg:'Treino do dia atualizado.'});}
    if(parsed.action==='send_message'){const sid=await resolve(parsed.student);if(!sid)return sendJson(res,200,{ok:false,msg:'Aluno não encontrado.'});await dbRun('INSERT INTO messages (id,student_id,from_role,text) VALUES (?,?,?,?)', uid('msg'),sid,'personal',parsed.text||'');return sendJson(res,200,{ok:true,msg:'Mensagem enviada.'});}
    return sendJson(res,200,{ok:false,msg:parsed.message||'Ação não reconhecida.'});
  }catch(err){return sendJson(res,200,{ok:false,msg:'Erro ao executar: '+err.message});}
});

route('GET','/api/health',async(req,res)=>{sendJson(res,200,{ok:true,time:now(),db:usingRemoteDb?'turso(libsql-remoto,persistente)':'sqlite-local(arquivo,NAO persistente em hosts com disco efemero)'});});

// ── SERVIDOR + ARQUIVOS ESTÁTICOS ────────────────────────────
const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS'){sendJson(res,200,{});return;}
  const urlPath=req.url.split('?')[0];
  if(urlPath.startsWith('/api/')||urlPath==='/api'){
    for(const r of routes){
      if(r.method!==req.method) continue;
      const m=urlPath.match(r.regex);
      if(!m) continue;
      const params={};r.keys.forEach((k,i)=>params[k]=decodeURIComponent(m[i+1]));
      try{await r.handler(req,res,params);}catch(err){
        if(err.status) sendJson(res,err.status,{error:err.message});
        else{console.error(err);sendJson(res,500,{error:err.message});}
      }
      return;
    }
    sendJson(res,404,{error:'Rota não encontrada.'});
    return;
  }
  if(req.method!=='GET'){res.writeHead(405);res.end();return;}
  const try1=urlPath==='/'?path.join(PUBLIC_DIR,'index.html'):path.join(PUBLIC_DIR,urlPath);
  if(!try1.startsWith(PUBLIC_DIR)){res.writeHead(403);res.end();return;}
  fs.readFile(try1,(err,data)=>{
    if(err){fs.readFile(path.join(PUBLIC_DIR,'index.html'),(err2,d2)=>{if(err2){res.writeHead(404);res.end('Não encontrado');return;}res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(d2);});return;}
    res.writeHead(200,{'Content-Type':MIME[path.extname(try1)]||'application/octet-stream'});res.end(data);
  });
});

async function main(){
  await initDb();
  await seedIfEmpty();
  server.listen(PORT,()=>{
    console.log(`VIGOR backend rodando em http://localhost:${PORT}`);
    if(usingRemoteDb){
      console.log(`Banco de dados: Turso/libSQL remoto (persistente) → ${process.env.TURSO_DATABASE_URL}`);
    } else {
      console.log(`Banco de dados: arquivo local em ${DB_PATH} (NÃO persistente em hosts com disco efêmero, ex: Render free)`);
      console.log(`Para persistência real em produção, defina TURSO_DATABASE_URL e TURSO_AUTH_TOKEN.`);
    }
    console.log(`Login demo → personal@vigor.app / vigor123 | aluno → marina@exemplo.com / aluno123`);
  });
}
main().catch(err=>{
  console.error('Falha ao iniciar o servidor:', err);
  process.exit(1);
});

module.exports={server,db};
