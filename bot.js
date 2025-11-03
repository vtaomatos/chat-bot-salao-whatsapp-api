import express from 'express'
import axios from 'axios'
import OpenAI from 'openai'
import dotenv from 'dotenv'
import { readFileSync } from 'fs'

dotenv.config()

const app = express()
app.use(express.json())

const clientAI = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const sessions = {}

const TIMEOUT_ATENDIMENTO = 24 * 60 * 60 * 1000 // 24h
const BUFFER_TIME = 2 * 60 * 1000 // 2 minutos
const MAX_HISTORY = 10

// API WhatsApp
const WHATSAPP_API = process.env.WPP_API_URL
const ENV_IS_TEST = process.env.ENV_IS_TEST || false
if (ENV_IS_TEST) {
  console.log('⚠️ Modo de teste ativado. Usando sessão e API key de teste.')
}
const SESSION_ID = process.env.WPP_SESSION
const API_KEY = process.env.WPP_API_KEY

const grupoAtendimento = '120363418732966493@g.us'


// 📘 Informações fixas
// const INFOS_FIXAS_CURSOS = `
//     - Curso Nagô Penteado: R$ 550 | 1 dia (8h)
//     - Curso Nagô Detalhado com Jumbo: R$ 850 | 2 dias (6h/dia)
//     - Curso Box Braids: R$ 850 | 2 dias (6h/dia)
//     - Curso Entrelace VIP: R$ 850 | 2 dias (6h/dia)
//     - Matrícula: R$ 50 (sinal)
// `

// 🔹 Carregar dúvidas do arquivo
function carregarDuvidas () {
  console.log('Entrou em carregar duvidas')
  try {
    const raw = readFileSync('./duvidas.json', 'utf-8')
    const data = JSON.parse(raw)
    return data.data
      .map(d => `Pergunta: ${d.duvida}\nResposta: ${d.resposta}`)
      .join('\n\n')
  } catch (err) {
    console.error('Erro ao carregar duvidas.json:', err)
    return ''
  }
}
const INFOS_DUVIDAS = carregarDuvidas()

function resetSession (from) {
  console.log(`🔄 Resetando sessão para ${from}`)
  if (sessions[from]?.timeoutId) clearTimeout(sessions[from].timeoutId)
  sessions[from] = {
    atendimentoAtivo: false,
    timeoutId: null,
    pendingMessages: [],
    history: [],
    bufferTimer: null,
    falhasConsecutivas: 0,
  }
}

function startTimeoutAtendimento (from) {
  console.log(`⏳ Iniciando timeout de atendimento para ${from}`)
  const session = sessions[from]
  if (!session) return
  if (session.timeoutId) clearTimeout(session.timeoutId)

  session.timeoutId = setTimeout(async () => {
    session.atendimentoAtivo = false
    session.timeoutId = null
    console.log('O atendimento automático foi reativado para: ', to)
  }, TIMEOUT_ATENDIMENTO)
}

async function apresentarIA (to) {

  if (ENV_IS_TEST) {
    console.log('⚠️ Modo de teste: mensagem de apresentação da IA não será enviada.')
    await enviarMensagem( to, `Olá! Sou um robô e estou sendo testado. 🤖💁🏽‍♀️✨
      Algumas mensagens podem não fazer muito sentido, ou não serem respondidas corretamente.
      Obrigado pela compreensão!`)
    return
  }

  console.log(`🤖 Apresentando IA para ${to}`)
  await enviarMensagem(
    to,
    `Olá! Sou a IA Damaris Braids 🤖💁🏽‍♀️✨
Estou aqui para tirar suas dúvidas e adiantar seu atendimento.
Confira nosso catálogo completo aqui:  
https://wa.me/c/5513997833427  

E agende diretamente pelo link:  
https://online.maapp.com.br/StudioDamarisBraids

*Já vou te responder!*`
  )
}

async function enviarMensagem (to, text) {
  console.log(`Iniciando envio de mensagem para ${to}`)
  try {
    console.log(`📤 Enviando mensagem para ${to}: "${text}"`)

    const url = `${WHATSAPP_API}/client/sendMessage/${SESSION_ID}?api_key=${API_KEY}`
    const body = {
      chatId: to,
      contentType: 'string',
      content: text,
    }

    const response = await axios.post(url, body, {
      headers: { 
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
       },
    })

    if (response.data.success) {
      console.log(`✅ Mensagem enviada com sucesso para ${to}`)
    } else {
      console.warn('⚠️ Falha ao enviar mensagem:', response.data)
    }
  } catch (err) {
    const errorMsg =
      err.response?.data ||
      err.message ||
      'Erro desconhecido ao enviar mensagem'
    console.error('❌ Erro ao enviar mensagem:', errorMsg)
  }
}

async function chamarGPT (from, mensagensAgrupadas) {
  console.log(`🤖 Chamando GPT para ${from} com mensagens:`, mensagensAgrupadas)
  const session = sessions[from]
  const historico = session.history.slice(-MAX_HISTORY)

  const KNOWLEDGE_BASE = `
Você é a IA oficial do Studio Damaris Braids. Você praticamente é a Damaris, mas em versão virtual. Sempre objetiva, simpática e prestativa.
Responda sempre em JSON, sem texto fora do JSON.
Se souber o que responder, use este formato:
{
"resposta": "texto da resposta para o cliente",
"atendente": false
}
Se não souber, devolva no formato acima uma pergunta para entender melhor.
Agora, caso ja tiver nas mensagens anteriores que você ja perguntou 2x e ainda não souber responder use este formato:
{
"resposta": "texto da resposta para o cliente avisando que um atendente humano entrará em contato em breve.",
"atendente": true
}
`
// Informações cursos:
// ${INFOS_FIXAS_CURSOS}
+
`
Perguntas frequentes:
${INFOS_DUVIDAS}
`

  const mensagensParaGPT = [
    { role: 'system', content: KNOWLEDGE_BASE },
    ...historico.map(h => ({ role: h.role, content: h.text })),
    { role: 'user', content: mensagensAgrupadas.join('\n') },
  ]

  try {
    const response = await clientAI.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: mensagensParaGPT,
    })

    const text = response.choices[0].message.content
    const match = text.match(/\{[\s\S]*\}/)
    const parsed = match ? JSON.parse(match[0]) : { resposta: text, atendente: false }

    session.history.push({ role: 'user', text: mensagensAgrupadas.join(' | ') })
    session.history.push({ role: 'assistant', text: parsed.resposta })

    return parsed
  } catch (err) {
    console.error('Erro GPT:', err)
    await ativarAtendente(from, 'Erro ao processar mensagem', true)
  }
}

async function ativarAtendente (from, ultimaMsg, erro = false) {
  console.log(`👩🏽‍💼 Ativando atendente para ${from}`)
  if (erro) await enviarMensagem(from, 'Houve um erro no atendimento automático. Vou te direcionar para um atendente.')

  if (!sessions[from]) resetSession(from)

  const session = sessions[from]
  if (session.atendimentoAtivo) {
    await enviarMensagem(from, 'Um atendente já está em atendimento com você.')
    return;
  }

  session.atendimentoAtivo = true
  session.falhasConsecutivas = 0
  if (session.timeoutId) clearTimeout(session.timeoutId)

  await enviarMensagem(
    from,
    `Um atendente falará com você.  

⚠️ O atendimento via WhatsApp pode levar até 24 horas, conforme ordem de chegada.  

Confira nosso catálogo completo aqui:  
https://wa.me/c/5513997833427  

E agende diretamente pelo link:  
https://online.maapp.com.br/StudioDamarisBraids`
  )

  const numeroCliente = from.replace('@c.us', '')
  await avisarGrupoContatoRebido(numeroCliente, ultimaMsg, 'Mensagem não respondida pela IA')

  startTimeoutAtendimento(from)
}

async function avisarGrupoContatoRebido(numeroCliente, ultimaMsg, motivo) {
  await enviarMensagem(
    grupoAtendimento,
    `⚠️ *Novo pedido de atendimento*  
Cliente: [${numeroCliente}](https://wa.me/${numeroCliente})
Motivo: *${motivo || 'Mensagem não respondida pela IA'}*  
Mensagem: "${ultimaMsg}"`
  )
}

async function processarBuffer (from) {
  console.log(`⏳ Processando buffer de mensagens para ${from}`)
  const session = sessions[from]
  const mensagensAgrupadas = [...session.pendingMessages]
  session.pendingMessages = []
  session.bufferTimer = null

  const respostaGPT = await chamarGPT(from, mensagensAgrupadas)
  if (!respostaGPT) return

  if (respostaGPT.atendente) {
    await enviarMensagem(from, respostaGPT.resposta)
    await ativarAtendente(from, mensagensAgrupadas.join(' | '))
  }
}

// 📩 Recebe mensagens do WhatsApp
app.post('/webhook', async (req, res) => {
console.log('🔔 Webhook recebido:')
console.log('Headers:', req.headers)
console.log('Body:', JSON.stringify(req.body, null, 2))

  const body = req.body
  if (!body || body.dataType !== 'message') return res.sendStatus(200)

  const message = body.data.message
  const from = message.from
  const msgRaw = message.body?.trim()

  console.log('📩 Mensagem recebida:')
  console.log(`   Remetente: ${from}`)
  console.log(`   Conteúdo: ${msgRaw}`)


  if (!msgRaw || message.isGroupMsg) return res.sendStatus(200)

  if (!sessions[from]) {
    resetSession(from)
    await avisarGrupoContatoRebido(numeroCliente, ultimaMsg, 'Novo contato iniciado')
    await apresentarIA(from)
  }

  const session = sessions[from]
  if (session.atendimentoAtivo) {
    startTimeoutAtendimento(from)
    return res.sendStatus(200)
  }

  if (msgRaw.toLowerCase() === 'falar com atendente') {
    session.falhasConsecutivas = 0
    await ativarAtendente(from, msgRaw)
    return res.sendStatus(200)
  }

  session.pendingMessages.push(msgRaw)
  if (!session.bufferTimer) {
    session.bufferTimer = setTimeout(() => processarBuffer(from), BUFFER_TIME)
  }

  res.sendStatus(200)
})

app.listen(process.env.PORT, () => {
  console.log(`🤖 Bot rodando na porta ${process.env.PORT}`)
})
