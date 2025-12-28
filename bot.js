import express from 'express'
import axios from 'axios'
import OpenAI from 'openai'
import dotenv from 'dotenv'
import { readFileSync } from 'fs'
import { MinhaAgendaRepository } from "./minha_agenda_repository.js"


dotenv.config()

const minhaAgenda = new MinhaAgendaRepository({
  usuario: process.env.MINHA_AGENDA_USER,
  senha: process.env.MINHA_AGENDA_SENHA
});

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
function carregarDuvidas() {
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


function carregarServicos() {
  try {
    const file = readFileSync('./lista_serrvicos.json', 'utf-8')
    const json = JSON.parse(file)

    return Array.isArray(json.servicos) ? json.servicos : []
  } catch (err) {
    console.error('Erro ao carregar lista_serrvicos.json:', err)
    return []
  }
}

const INFOS_SERVICOS = carregarServicos()

function resetSession(from) {
  console.log(`🔄 Resetando sessão para ${from}`)
  if (sessions[from]?.timeoutId) clearTimeout(sessions[from].timeoutId)
  sessions[from] = {
    atendimentoAtivo: false,
    timeoutId: null,
    pendingMessages: [],
    history: [],
    bufferTimer: null,
  }
}

function startTimeoutAtendimento(from) {
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

async function apresentarIA(to) {

  if (ENV_IS_TEST) {
    console.log('⚠️ Modo de teste: mensagem de apresentação da IA não será enviada.')
    await enviarMensagem(to, `Olá! Sou um robô e estou sendo testado. 🤖💁🏽‍♀️✨
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

async function enviarMensagem(to, text) {
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

async function chamarGPT(from, mensagensAgrupadas) {
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
Se for para agendar atendimetno peça os dados: nome, telefone (somente numeros), serviço, data (dd/mm/aaaa) e hora(hh:mm). E retorne no formato abaixo:
{
"solicitacao_agendamento": {
"nome": "Nome do cliente",
"servico": "Serviço desejado",
"telefone": "11999999999"
"data": "DD/MM/AAAA",
"hora": "HH:MM"
},
"resposta": "texto da resposta para o cliente informando que o agendamento será processado.",
"atendente": false
}
Quando for confirmação será explicito que é uma confirmação. A chave é "confirmacao_agendamento" e deve conter os mesmos dados da solicitação de agendamento.
Se for consultar agendamento peça os dados: nome, telefone (somente números), data (dd/mm/aaaa) e hora(hh:mm). E retorne no formato abaixo:
{
"consulta_agendamento": {
"nome": "Nome do cliente",
"telefone": "11999999999",
"data": "DD/MM/AAAA",
"hora": "HH:MM"
},
"resposta": "texto da resposta para o cliente infomando que está buscando as informações do agendamento.",
"atendente": false
}
Se for solicitação de cancelamento de agendamento peça os dados: nome, telefone (somente números), data (dd/mm/aaaa) e hora(hh:mm). E retorne no formato abaixo:
{
"solicitacao_cancelamento_agendamento": {
"nome": "Nome do cliente",
"telefone": "11999999999",
"data": "DD/MM/AAAA",
"hora": "HH:MM"
},
"resposta": "texto da resposta para o cliente informando que o cancelamento será processado.",
"atendente": false
}
Se for confirmação de cancelamento de agendamento a chave é "confirmacao_cancelamento_agendamento" e deve conter os mesmos dados da solicitação de cancelamento.
Se for solicitação de alteração agendamento peça os dados: nome, telefone (somente números), data (dd/mm/aaaa), hora (hh:mm), nova data (dd/mm/aaaa) e nova hora(hh:mm). E retorne no formato abaixo:
{
"alteracao_agendamento": {
"novo" :{
"nome": "Nome do cliente",
"telefone": "11999999999",
"data": "DD/MM/AAAA",
"hora": "HH:MM",
"nova_data": "DD/MM/AAAA",
"nova_hora": "HH:MM"
},
"antigo" :{
"telefone": "11999999999",
"data": "DD/MM/AAAA",
"hora": "HH:MM"
}},
"resposta": "texto da resposta para o cliente informando que a alteração será processada.",
"atendente": false
}
Se for confirmação de alteração de agendamento a chave é "confirmacao_alteracao_agendamento" e deve conter os mesmos dados da solicitação de alteração.
Para os procedimentos de agendamento, consulta, cancelamento ou alteração, o cliente deve fornecer todas as informações solicitadas. Só deve retornar o JSON com os dados quando todas as informações forem fornecidas.
Cada serviço tem suas regras e condições para determinarmos alguma variação de tempo de duração ou preço para o cliente. Então faça as perguntas necessárias para precificar e determinar tempo conforme os dados fornecidos aqui:

`
    + INFOS_SERVICOS +
    `
Se o cliente mencionar que enviou áudio, vídeo, foto, link ou documento, responda pedindo para ele descrever em texto e NÃO tente interpretar a mídia.
Caso o cliente não possa digitar, transfira para um atendente humano.

Perguntas frequentes:
${INFOS_DUVIDAS}
`

  // Informações cursos:
  // ${INFOS_FIXAS_CURSOS}


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

async function ativarAtendente(from, ultimaMsg, erro = false) {
  console.log(`👩🏽‍💼 Ativando atendente para ${from}`)
  if (erro) await enviarMensagem(from, 'Houve um erro no atendimento automático. Vou te direcionar para um atendente.')

  if (!sessions[from]) resetSession(from)

  const session = sessions[from]
  if (session.atendimentoAtivo) {
    await enviarMensagem(from, 'Um atendente já está em atendimento com você.')
    return;
  }

  session.atendimentoAtivo = true
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


  // ✅ FORÇAR CONVERSA COMO NÃO LIDA PARA ATENDENTE
  try {
    await axios.post(
      `${WHATSAPP_API}/client/markAsUnread/${SESSION_ID}?api_key=${API_KEY}`,
      { chatId: from }
    )
    console.log(`✅ Conversa marcada como não lida para ${from}`)
  } catch (err) {
    console.log("⚠️ Falha ao marcar como não lida:", err?.response?.data || err.message)
  }

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

async function pegarServicoSolicitado(mensagensAgrupadas, respostaGPT, listaDeServicos) {
  // Nome informado pela IA (ou pelo cliente)
  const nomeInformado = respostaGPT?.solicitacao_agendamento?.servico;
  if (!nomeInformado) {
    return {
      servico: null,
      identificado: false,
      mensagemParaUsuario: "Não consegui identificar o serviço desejado. Servicos Disponíveis:\n" +
        listaDeServicos.servicos
          .map(s => `- ${s.nome} (${s.duracao} min) – ${s.preco || ""}`)
          .join("\n") +
        "\n\nPor favor, responda exatamente com o nome do serviço que deseja."
    };
  }

  // --- 🔤 Função que normaliza strings para comparação
  const normalize = (str) =>
    str
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // remove acentos
      .replace(/[^a-z0-9 ]/g, "") // remove caracteres especiais
      .trim();

  const nomeNormalizado = normalize(nomeInformado);

  // --- Lista normalizada de serviços
  const servicos = listaDeServicos.servicos || [];

  // --- 1️⃣ Tentativa direta de encontrar correspondência exata
  let servicoEncontrado = servicos.find(s => normalize(s.nome) === nomeNormalizado);

  // --- 2️⃣ Tentativa aproximada (o nome informado está contido no nome do serviço)
  if (!servicoEncontrado) {
    servicoEncontrado = servicos.find(s =>
      normalize(s.nome).includes(nomeNormalizado) ||
      nomeNormalizado.includes(normalize(s.nome))
    );
  }

  // --- 3️⃣ Se encontrou, retorna
  if (servicoEncontrado) {
    return {
      servico: servicoEncontrado,
      identificado: true,
      mensagemParaUsuario: null
    };
  }

  // --- 4️⃣ Se NÃO encontrou, monta lista para o cliente
  const listaFormatada = servicos
    .map(s => `- ${s.nome} (${s.duracao} min) – ${s.preco || ""}`)
    .join("\n");

  const msg =
    "Não consegui identificar qual serviço você deseja agendar. 🤔\n\n" +
    "Aqui está a lista completa de serviços disponíveis:\n\n" +
    listaFormatada +
    "\n\nPor favor, responda exatamente com o nome do serviço que deseja.";

  return {
    servico: null,
    identificado: false,
    mensagemParaUsuario: msg
  };
}



async function processarBuffer(from) {
  console.log(`⏳ Processando buffer de mensagens para ${from}`)
  const session = sessions[from]
  const mensagensAgrupadas = [...session.pendingMessages]
  session.pendingMessages = []
  session.bufferTimer = null

  const respostaGPT = await chamarGPT(from, mensagensAgrupadas)
  if (!respostaGPT || !respostaGPT.resposta) {
    await enviarMensagem(from, 'Erro de resposta da Ia.')
    ativarAtendente(from, mensagensAgrupadas.join(' | '), true)
    return
  }

  if (respostaGPT.atendente) {
    await ativarAtendente(from, mensagensAgrupadas.join(' | '))
    return
  }

  await enviarMensagem(from, respostaGPT.resposta)

  //O que eu vou receber no campo respostaGPT.solicitacao_agendamento é um objeto. Precisa validar corretamente. 
  if (respostaGPT.solicitacao_agendamento) {

    // Aqui processar agendamento
    console.log('📅 Solicitação de agendamento recebida:', respostaGPT.solicitacao_agendamento)

    //1. validar o objeto recebido no respostaGPT.solicitacao_agendamento;
    //2. Buscar a duração do serviço no arquivo de infomações dos procedimentos (se não existe eu vou criar com as infos da revista)
    //3. mandar a chamada com esse objeto montado.
    // 1) Duração padrão caso o serviço não seja encontrado
    let duracaoMinutos = 90;

    // 2) Carrega o JSON de serviços
    // Exemplo: listaDeServicos = [{ nome: "Trança", duracao: 120 }, ...]
    const listaDeServicos = require("./lista_servicos.json");


    //checar nome do procedimento
    //pegar mensagens do cliente + json de resposta do gpt + a lista de serviços 
    //Enviar de volta para o gpt com um prompt pedindo para localizar exatamente qual serviço o cliente quer solicitar

    const resultadoServico = await pegarServicoSolicitado(mensagensAgrupadas, respostaGPT, listaDeServicos);

    if (!resultadoServico.identificado) {
      await enviarMensagem(from, resultadoServico.mensagemParaUsuario);
      return; // interrompe o fluxo até o cliente responder corretamente
    }

    const servicoEncontrado = resultadoServico.servico;

    // 4) Se achou, usa a duração correta
    duracaoMinutos = parseInt(servicoEncontrado.duracao, 10) ?? duracaoMinutos;
    console.log(`✅ Serviço encontrado: ${servicoEncontrado.nome} (${duracaoMinutos} min)`);

    // 5) Objeto de duração que será fundido no agendamento
    const duracao = { duracao: duracaoMinutos };

    // 6) Monta objeto final de agendamento
    const agendamento = {
      ...respostaGPT.solicitacao_agendamento,
      ...duracao
    };

    console.log("📌 Agendamento final:", agendamento);

    // 7) Chama minhaAgendaRepository.setAgendamento corretamente
    const resultado = await minhaAgenda.checarConflitoOuSugerirHorariosAlternativos(agendamento);

    if (resultado.ok) {

      // ------------------------------
      // 📌 Mensagem revisando os dados
      // ------------------------------
      const msgConfirmacao =
        `Perfeito! Encontrei um horário disponível pra você. 😊\n\n` +
        `Vamos revisar rapidinho antes de confirmar:\n\n` +
        `📅 *Data:* ${resultado.data}\n` +
        `⏰ *Horário:* ${resultado.horario}\n` +
        `💆‍♀️ *Serviço:* ${resultado.servico}\n` +
        `⏳ *Duração:* ${resultado.duracao} min\n` +
        `💲 *Preço:* ${resultado.preco}\n\n` +
        `Se estiver tudo certo, responda *CONFIRMAR*.\n` +
        `Se quiser alterar algum dado, é só me avisar!`;

      await enviarMensagem(from, msgConfirmacao);
      return;

    } else if (resultado?.diasAlternativos?.length > 0) {

      // ---------------------------------------------
      // 📌 Horários alternativos / dias alternativos
      // ---------------------------------------------
      let alternativasMsg = "Não consegui agendar no horário solicitado 😕\n\n" +
        "Mas encontrei algumas alternativas próximas:\n\n";

      resultado.diasAlternativos.forEach(dia => {
        alternativasMsg += `📅 *${dia.data}*\n`;

        dia.janelas.forEach(j => {
          alternativasMsg +=
            `   • Entre *${j.inicioMinimo}* e *${j.inicioMaximo}*\n`;
        });

        alternativasMsg += "\n";
      });

      alternativasMsg +=
        "Pode escolher um desses horários, ou me dizer outra data que prefere!";

      await enviarMensagem(from, alternativasMsg);
      return;

    } else {

      // --------------------------------------------
      // 📌 Nenhuma alternativa + erro na disponibilidade
      // --------------------------------------------
      await enviarMensagem(
        from,
        "Não consegui consultar a disponibilidade no momento 😕\n" +
        "Por favor, aguarde. Um atendente verificará manualmente para você. 🙏"
      );
      console.log("✅ Resultado do agendamento:", JSON.stringify(resultado));

      return;
    }
  }

  if (respostaGPT.confirmacao_agendamento) {

    // Aqui processar agendamento
    console.log('📅 Solicitação de agendamento recebida:', respostaGPT.solicitacao_agendamento)

    //1. validar o objeto recebido no respostaGPT.solicitacao_agendamento;
    //2. Buscar a duração do serviço no arquivo de infomações dos procedimentos (se não existe eu vou criar com as infos da revista)
    //3. mandar a chamada com esse objeto montado.
    // 1) Duração padrão caso o serviço não seja encontrado
    let duracaoMinutos = 90;

    // 2) Carrega o JSON de serviços
    // Exemplo: listaDeServicos = [{ nome: "Trança", duracao: 120 }, ...]
    const listaDeServicos = require("./lista_servicos.json");


    //checar nome do procedimento
    //pegar mensagens do cliente + json de resposta do gpt + a lista de serviços 
    //Enviar de volta para o gpt com um prompt pedindo para localizar exatamente qual serviço o cliente quer solicitar

    const resultadoServico = await pegarServicoSolicitado(mensagensAgrupadas, respostaGPT, listaDeServicos);

    if (!resultadoServico.identificado) {
      await enviarMensagem(from, resultadoServico.mensagemParaUsuario);
      return; // interrompe o fluxo até o cliente responder corretamente
    }

    const servicoEncontrado = resultadoServico.servico;

    // 4) Se achou, usa a duração correta
    duracaoMinutos = parseInt(servicoEncontrado.duracao, 10) ?? duracaoMinutos;
    console.log(`✅ Serviço encontrado: ${servicoEncontrado.nome} (${duracaoMinutos} min)`);

    // 5) Objeto de duração que será fundido no agendamento
    const duracao = { duracao: duracaoMinutos };

    // 6) Monta objeto final de agendamento
    const agendamento = {
      ...respostaGPT.solicitacao_agendamento,
      ...duracao
    };

    console.log("📌 Agendamento final:", agendamento);

    // 7) Chama minhaAgendaRepository.setAgendamento corretamente
    const resultado = await minhaAgenda.setAgendamento(agendamento);

    if (resultado.ok) {

      // ------------------------------
      // 📌 Mensagem de que deu tudo certo
      // ------------------------------
      await enviarMensagem(
        from,
        `✨ *Agendamento realizado com sucesso!* ✨\n\n` +
        `📅 *Data:* ${resultado.data}\n` +
        `⏰ *Horário:* ${resultado.horario}\n` +
        `💆‍♀️ *Serviço:* ${resultado.servico}\n\n` +
        `Tudo certo por aqui! Qualquer coisa é só me chamar 😊`
      );

      return;

    } else {

      // --------------------------------------------
      // 📌 Erro sem alternativas — atendente assume
      // --------------------------------------------
      await enviarMensagem(
        from,
        "Não consegui finalizar seu agendamento agora 😕\n" +
        "Por favor, aguarde. Um atendente verificará manualmente para você. 🙏"
      );

      return;
    }

  }

  if (respostaGPT.consulta_agendamento) {
    console.log('🔍 Solicitação de consulta de agendamento recebida:', respostaGPT.consulta_agendamento);

    try {
      const dadosConsulta = respostaGPT.consulta_agendamento;

      // Pode vir nome, telefone ou ambos dependendo do GPT
      const nome = dadosConsulta.nome_cliente || nomeContato;
      const telefone = dadosConsulta.telefone_cliente || telCliente;

      // -----------------------------------------
      // 📌 Consulta ao repositório da agenda
      // -----------------------------------------
      const agendamento = await minhaAgendaRepository.getAgendamento({
        nome_cliente: nome,
        telefone_cliente: telefone
      });

      console.log("Resultado consulta:", agendamento);

      // ======================================================
      // 1️⃣ AGENDAMENTO ENCONTRADO (caso principal)
      // ======================================================
      if (agendamento?.agendamento) {

        const a = agendamento.agendamento;

        await enviarMensagem(
          from,
          `📌 *Aqui está seu agendamento:*\n\n` +
          `👤 *Cliente:* ${a.nome_cliente}\n` +
          `💆‍♀️ *Serviço:* ${a.nome_servico}\n` +
          `📅 *Data:* ${a.data}\n` +
          `⏰ *Horário:* ${a.horario}\n` +
          `⏳ *Duração:* ${a.duracao || "—"} min\n` +
          `💲 *Preço:* ${a.preco || "—"}\n\n` +
          `Se quiser *alterar* ou *cancelar*, é só me dizer!`
        );

        return;
      }

      // ======================================================
      // 2️⃣ NÃO ENCONTROU ESSE AGENDAMENTO, MAS TEM *PRÓXIMOS*
      // ======================================================
      if (!agendamento?.agendamento && agendamento?.proximos?.length > 0) {

        let msg =
          "Não encontrei um agendamento ativo para essa data. 😕\n" +
          "Mas encontrei estes horários relacionados ao seu nome/telefone:\n\n";

        agendamento.proximos.forEach((p, i) => {
          msg +=
            `📅 *${p.data}* - ⏰ *${p.horario}*\n` +
            `💆‍♀️ ${p.nome_servico}\n\n`;
        });

        msg += "Se algum desses é o que você procura, me diga!";

        await enviarMensagem(from, msg);
        return;
      }

      // ======================================================
      // 3️⃣ NENHUM AGENDAMENTO ENCONTRADO
      // ======================================================
      await enviarMensagem(
        from,
        "Não encontrei nenhum agendamento ativo com seus dados. 😕\n" +
        "Se quiser, posso ajudar você a marcar um horário!"
      );

      return;

    } catch (err) {
      console.error("⚠️ Erro ao consultar agendamento:", err);

      await enviarMensagem(
        from,
        "Tive um problema ao consultar seu agendamento agora 😕\n" +
        "Por favor, aguarde enquanto um atendente verifica manualmente. 🙏"
      );

      return;
    }
  }

  if (respostaGPT.cancelamento_agendamento) {
    console.log('❌ Confirmação de cancelamento de agendamento recebida:', respostaGPT.cancelamento_agendamento);

    try {
      const dadosCancelamento = respostaGPT.cancelamento_agendamento;
      // -----------------------------------------
      // 📌 Cancelamento no repositório da agenda
      // -----------------------------------------
      const resultado = await minhaAgenda.cancelarAgendamento(dadosCancelamento);
      if (resultado.ok) {
        await enviarMensagem(
          from,
          `✅ Seu agendamento para *${resultado.data}* às *${resultado.horario}* foi cancelado com sucesso.\n\n` +
          `Se precisar de algo mais, é só me chamar!`
        );
      } else {
        await enviarMensagem(
          from,
          `❌ Não consegui cancelar seu agendamento: ${resultado.mensagem}\n\n` +
          `Por favor, aguarde enquanto um atendente verifica manualmente. 🙏`
        );
      }

    } catch (err) {
      console.error("⚠️ Erro ao cancelar agendamento:", err);
      await enviarMensagem(
        from,
        "Tive um problema ao cancelar seu agendamento agora 😕\n" +
        "Por favor, aguarde enquanto um atendente verifica manualmente. 🙏"
      );
    }
  }

  if (respostaGPT.alteracao_agendamento) {
    console.log('🔄 Confirmação de alteração de agendamento recebida:', respostaGPT.alteracao_agendamento);
    try {
      const antigoAgendamento = respostaGPT.alteracao_agendamento.antigo;
      const novosAgendamento = respostaGPT.alteracao_agendamento.novo;
      // -----------------------------------------
      // 📌 Alteração no repositório da agenda
      // -----------------------------------------
      const resultado = await minhaAgenda.updateAgendamento(antigoAgendamento, novosAgendamento);
      if (resultado.ok) {
        await enviarMensagem(
          from,
          `✅ Seu agendamento foi alterado com sucesso:\n\n` +
          `📅 *Nova Data:* ${resultado.nova_data}\n` +
          `⏰ *Novo Horário:* ${resultado.novo_horario}\n\n` +
          `Se precisar de algo mais, é só me chamar!`
        );
      } else {
        await enviarMensagem(
          from,
          `❌ Não consegui alterar seu agendamento: ${resultado.mensagem}\n\n` +
          `Por favor, aguarde enquanto um atendente verifica manualmente. 🙏`
        );
      }
    } catch (err) {
      console.error("⚠️ Erro ao alterar agendamento:", err);
      await enviarMensagem(
        from,
        "Tive um problema ao alterar seu agendamento agora 😕\n" +
        "Por favor, aguarde enquanto um atendente verifica manualmente. 🙏"
      );
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


    if (message.isGroupMsg || tipo === "reaction") return res.sendStatus(200)

    // ✅ Se for mídia, áudio, vídeo, documento, ligação etc.
    const tipo = message.type

    const isTexto = (
      tipo === "chat" &&
      typeof message.body === "string" &&
      message.body.trim() !== ""
    )

    // Qualquer coisa que não seja texto = mídia
    if (!isTexto) {
      const session = sessions[from]

      // 1° tentativa → pedir para digitar
      if (!session.pediuTexto) {
        session.pediuTexto = true
        await enviarMensagem(
          from,
          "Ainda não consigo analisar midias (foto, vídeo, áudio, link ou documentos). Nem receber ligações. 😕\n\n" +
          "Você consegue *digitar a sua dúvida* pra eu te ajudar?"
        )
        return res.sendStatus(200)
      }

      // 2° tentativa → cliente insistiu em enviar mídia → transferir
      await ativarAtendente(from, `Enviou mídia do tipo: ${tipo}`)
      return res.sendStatus(200)
    }

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
}