# VIGOR — Backend v2 (completo)

## Iniciar localmente
```
cd vigor-backend
npm start
```
Abra: http://localhost:8787

## Credenciais de demonstração
- **Personal:** personal@vigor.app / vigor123
- **Alunos:** marina@exemplo.com / aluno123 (ou carlos, julia, pedro)

## Para criar sua conta de personal
Acesse o app → "Sou personal trainer — criar conta"

## Deploy no Render (gratuito)
1. Suba esta pasta no GitHub
2. Render → New + → Web Service → conecte o repositório
3. Build Command: (vazio) | Start Command: npm start | Plano: Free
4. Pronto — URL pública gerada em ~2 minutos

## O que está incluso nesta versão
- Auth real (login, registro personal/aluno, esqueci senha, reset)
- Múltiplos personals podem se cadastrar (multi-tenant)
- Área do aluno com login próprio (status trial → pro)
- Biblioteca de exercícios (32 pré-cadastrados + personalizados por personal)
  com vídeo, observações, divisão por grupo muscular
- Treinos: criar, editar, excluir; adicionar/remover exercícios;
  observação e dica do personal em cada exercício; calendário semanal
- RPE (percepção de esforço) registrado pelo aluno em cada exercício;
  cálculo automático de carga sugerida (80% de 1RM via fórmula Brzycki)
- Avaliações: Adipometria 3, 5 e 7 dobras (Jackson & Pollock);
  Perimetria com todos os campos (pescoço, braços, coxas, panturrilha...);
  Comparação automática entre avaliações; cálculo de IMC, %BF e RCQ
- Planos: catálogo com CRUD; atribuição manual pelo personal;
  configuração de PIX e link Mercado Pago; direcionamento para WhatsApp
- Chat bidirecional Personal ↔ Aluno
- Assistente IA por texto ou voz (executa ações reais no banco)
- Interface mobile (bottom nav, layouts responsivos)
- Log de auditoria completo (LGPD)
- Banco de dados SQLite persistente (portável para PostgreSQL)

## Endpoints principais
GET  /api/state                     → estado completo
POST /api/auth/login                → login
POST /api/auth/register-personal    → cadastro de personal
POST /api/auth/register-student     → cadastro de aluno
POST /api/auth/forgot-password      → recuperação de senha
POST /api/auth/reset-password       → redefinir senha
PUT  /api/students/:id/access       → ativar/desativar
PUT  /api/students/:id/plan         → atribuir plano
PUT  /api/students/:id/weekly-plan/:day → treino do dia
POST /api/students/:id/workouts     → novo treino
POST /api/workouts/:sid/:key/exercises → novo exercício
PUT  /api/exercises/:id             → editar exercício
DELETE /api/exercises/:id           → excluir exercício
POST /api/students/:id/assessments  → nova avaliação (cálculo automático)
PUT  /api/assessments/:id           → editar avaliação
POST /api/exercise-library          → novo exercício na biblioteca
GET  /api/exercise-library          → listar biblioteca
GET/PUT /api/personal/profile       → perfil do personal (PIX, MP, WA)
GET/POST/PUT/DELETE /api/plan-catalog → CRUD catálogo de planos
POST /api/students/:id/suggest-loads → sugestão de carga por RPE
POST /api/ai-command                → comando livre de IA
GET  /api/health                    → health check
