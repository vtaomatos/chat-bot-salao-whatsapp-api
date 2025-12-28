import puppeteer from "puppeteer";

export class MinhaAgendaRepository {
  constructor({ usuario, senha }) {
    this.usuario = usuario;
    this.senha = senha;
    this.baseUrl = "https://portal.minhaagendaapp.com.br";
  }

  async validarDataFutura(dataStr, horaStr) {
    try {
      // ✅ Converte "DD/MM/AAAA" → "AAAA-MM-DD"
      const [dia, mes, ano] = dataStr.split('/');
      if (!dia || !mes || !ano) {
        return { ok: false, reason: "Data inválida. Use o formato DD/MM/AAAA." };
      }

      // ✅ Monta string completa no padrão ISO (horário de Brasília)
      const dataISO = `${ano}-${mes}-${dia}T${horaStr}:00-03:00`;
      const dataCliente = new Date(dataISO);

      if (isNaN(dataCliente.getTime())) {
        return { ok: false, reason: "Data ou hora inválida." };
      }

      // ✅ Agora → pegar data e hora atual de Brasília
      const agora = new Date(
        new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" })
      );

      // ✅ Validação: o agendamento deve ser no futuro
      if (dataCliente <= agora) {
        console.log("❌ Cliente tentou agendar para um horário no passado:", dataCliente);
        return {
          ok: false,
          reason: "A data informada já passou. Por favor, escolha um horário futuro."
        };
      }

      return { ok: true };

    } catch (err) {
      console.log("❌ Erro ao validar data:", err);
      return { ok: false, reason: "Erro ao validar a data e hora informadas." };
    }
  }

  async checarConflitoOuSugerirHorariosAlternativos(agendamento, closeBrowser = true) {
    const browser = await puppeteer.launch({
      headless: false, // mostra o navegador (coloque true se quiser rodar em background)
      defaultViewport: null,
    });
    let page = null;
    try {
      console.log("============================================================");
      console.log("🔎 Iniciando checagem de conflitos e alternativas...");
      console.log("Agendamento solicitado:", agendamento);
      console.log("============================================================");

      // ---------------------------------------------------------
      // 1) Validar data futura
      // ---------------------------------------------------------
      const dataValida = await this.validarDataFutura(agendamento.data, agendamento.hora);
      if (!dataValida.ok) {
        console.log("🚫 Data futura inválida:", dataValida.reason);
        await this.closeBrowser(browser);
        return dataValida;
      }

      if (!browser) throw new Error("Browser não fornecido");

      const { cliente, data, hora, telefone } = agendamento;
      if (!cliente || !telefone) throw new Error("Cliente ou telefone ausente");

      // ---------------------------------------------------------
      // 2) Abrir navegador
      // ---------------------------------------------------------
      page = await browser.newPage();
      console.log("🌐 Página inicializando...");

      // LOGIN
      await page.goto(this.baseUrl + "/login", { waitUntil: "networkidle2" });
      await page.type('input[type="email"]', this.usuario, { delay: 10 });
      await page.type('input[type="password"]', this.senha, { delay: 10 });
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: "networkidle2" });

      console.log("✅ Login realizado.");
      await page.goto(`${this.baseUrl}/agenda`, { waitUntil: "networkidle2" });
      console.log("📅 Agenda carregada.");

      // ---------------------------------------------------------
      // 3) Parâmetros do sistema
      // ---------------------------------------------------------
      const DURATION = parseInt(agendamento.duracaoMinutos ?? 90, 10);
      const MAX_DAYS_AHEAD = 365;
      const MAX_DAYS_RETURN = 3;

      const EARLIEST = 8 * 60;   // 08:00
      const LATEST = 21 * 60;    // 21:00
      const CAPACITY = 2;        // dois profissionais

      console.log("⏱ Duração:", DURATION);
      console.log("👥 Capacidade simultânea:", CAPACITY);

      // ---------------------------------------------------------
      // Helpers internos (mantém o código limpo)
      // ---------------------------------------------------------
      const buildOccupancy = (intervals) => {
        const size = LATEST - EARLIEST;
        const occ = new Array(size).fill(0);

        for (const iv of intervals) {
          const s = Math.max(iv.start, EARLIEST);
          const e = Math.min(iv.end, LATEST);
          for (let t = s; t < e; t++) occ[t - EARLIEST]++;
        }
        return occ;
      };

      const computeWindows = (occ, duration) => {
        const latestStart = LATEST - duration;
        const windows = [];
        const allowed = [];

        for (let start = EARLIEST; start <= latestStart; start++) {
          let ok = true;
          for (let t = start; t < start + duration; t++) {
            if (occ[t - EARLIEST] >= CAPACITY) {
              ok = false;
              break;
            }
          }
          allowed.push(ok);
        }

        let i = 0;
        while (i < allowed.length) {
          if (!allowed[i]) { i++; continue; }
          const startIdx = i;
          let j = i + 1;
          while (j < allowed.length && allowed[j]) j++;
          windows.push({
            inicioMin: EARLIEST + startIdx,
            fimMin: EARLIEST + (j - 1)
          });
          i = j;
        }
        return windows;
      };

      // ---------------------------------------------------------
      // 4) Loop de busca
      // ---------------------------------------------------------
      let diasDisponiveis = [];
      let lookDate = this.parseDateDDMMYYYY(data);
      let checkedDays = 0;

      while (diasDisponiveis.length < MAX_DAYS_RETURN && checkedDays <= MAX_DAYS_AHEAD) {

        console.log("------------------------------------------------------------");
        console.log(`📅 Verificando dia ${this.formatDateDDMMYYYY(lookDate)} (dia ${checkedDays + 1})`);

        // abre datepicker
        await this.abrirDatePicker(page);

        const okMonth = await this.goToMonthYear(page, lookDate);
        if (!okMonth) {
          console.log("⚠️ Não navegou ao mês alvo — pulando");
          lookDate = this.addDays(lookDate, 1);
          checkedDays++;
          continue;
        }

        const sel = await this.selectDayInCalendar(page, lookDate.getDate());
        if (!sel) {
          console.log("⚠️ Dia não clicável — avançando");
          lookDate = this.addDays(lookDate, 1);
          checkedDays++;
          continue;
        }

        await page.waitForSelector('.fc-body', { timeout: 5000 }).catch(() => { });

        const intervals = await this.collectBookedIntervalsForDay(page);
        const occ = buildOccupancy(intervals);

        // ---------------------------------------------------------
        // ✅ LOGS TÉCNICOS DO DIA
        // ---------------------------------------------------------
        console.log("\n🗂 AGENDAMENTOS DO DIA:");
        console.table(intervals.map(iv => ({
          inicio: this.minutesToTimeString(iv.start),
          fim: this.minutesToTimeString(iv.end)
        })));

        console.log("\n🔥 ZONAS CRÍTICAS (carga >= capacidade):");
        let zonas = [];
        let inside = false;
        let zStart = null;

        for (let t = EARLIEST; t < LATEST; t++) {
          if (occ[t - EARLIEST] >= CAPACITY) {
            if (!inside) {
              inside = true;
              zStart = t;
            }
          } else if (inside) {
            zonas.push({ start: zStart, end: t });
            inside = false;
          }
        }
        if (inside) zonas.push({ start: zStart, end: LATEST });

        if (zonas.length === 0) console.log("✅ Sem zonas críticas");
        else console.table(zonas.map(z => ({
          inicio: this.minutesToTimeString(z.start),
          fim: this.minutesToTimeString(z.end)
        })));

        // ---------------------------------------------------------
        // ✅ Avaliar conflito do horário solicitado
        // ---------------------------------------------------------
        if (checkedDays === 0) {
          const userStart = this.timeToMinutes(hora);
          const userEnd = userStart + DURATION;

          let conflito = false;
          for (let t = userStart; t < userEnd; t++) {
            if (occ[t - EARLIEST] >= CAPACITY) {
              conflito = true;
              break;
            }
          }

          console.log("\n🔎 Avaliando horário solicitado:", hora);

          if (!conflito) {
            console.log("✅✅ Sem conflito — horário permitido!");

            const result = {
              ok: true,
              mensagem: "Horário disponível e permitido"
            };

            console.log("📦 Resultado:", await JSON.stringify(result, null, 2));
            if (closeBrowser) await this.closeBrowser(browser);
            return result;
          }

          console.log("❌ Horário solicitado está em conflito — buscando alternativas...");
        }

        // ---------------------------------------------------------
        // ✅ Gerar janelas alternativas
        // ---------------------------------------------------------
        const windows = computeWindows(occ, DURATION);

        console.log("\n🪟 Janelas do dia:");
        if (windows.length === 0) console.log("Nenhuma janela disponível.");
        else {
          console.table(windows.map(w => ({
            inicioMinimo: this.minutesToTimeString(w.inicioMin),
            inicioMaximo: this.minutesToTimeString(w.fimMin)
          })));

          diasDisponiveis.push({
            data: this.formatDateDDMMYYYY(lookDate),
            janelas: windows.map(w => ({
              inicioMinimo: this.minutesToTimeString(w.inicioMin),
              inicioMaximo: this.minutesToTimeString(w.fimMin)
            }))
          });
        }

        lookDate = this.addDays(lookDate, 1);
        checkedDays++;
      }

      // ---------------------------------------------------------
      // ✅ FINAL
      // ---------------------------------------------------------
      if (closeBrowser) await this.closeBrowser(browser);

      const result = diasDisponiveis.length > 0
        ? {
          ok: false,
          mensagem: "Horário solicitado possui conflito. Veja alternativas.",
          diasAlternativos: diasDisponiveis
        }
        : {
          ok: false,
          mensagem: "Nenhuma disponibilidade encontrada nos próximos 365 dias.",
          diasAlternativos: []
        };

      console.log("============================================================");
      console.log("📦 Resultado FINAL:");
      console.log(JSON.stringify(result, null, 2));
      console.log("============================================================");

      return result;

    } catch (err) {
      console.error("❌ Erro em checarConflitoOuSugerirHorariosAlternativos:", err);
      if (browser) await this.closeBrowser(browser);

      return {
        ok: false,
        mensagem: "Erro interno na análise de conflito."
      };
    }
  }

  async setAgendamento(agendamento, closeBrowser = true) {
    const browser = await puppeteer.launch({
      headless: false, // mostra o navegador (coloque true se quiser rodar em background)
      defaultViewport: null,
    });
    // Validar se a data e hora são futuras
    const dataValida = await this.validarDataFutura(agendamento.data, agendamento.hora);
    if (dataValida.ok === false) {
      console.log("🚨 Data ou hora inválida para agendamento:", dataValida.reason)
      this.closeBrowser(browser)
      return dataValida
    }

    const horarioDisponivel = await this.checarConflitoOuSugerirHorariosAlternativos(agendamento)

    if (horarioDisponivel)

      if (horarioDisponivel.ok === false) {
        console.log("🚨 Não é possível agendar nesse horario por conflito de agenda. Horarios disponíveis para esse procedimento nos proximos dias: ",
          JSON.stringify(horarioDisponivel.diasAlternativos).trim() ?? "Sem horario nos proximos 365 dias.")
        if (closeBrowser) this.closeBrowser(browser);
        return { ok: false, reason: "Não é possível agendar nesse horario por conflito de agenda.", diasAlternativos: horarioDisponivel.diasAlternativos ?? [] }
      }

    const page = await browser.newPage();

    // Acessa a página de login
    await page.goto(this.baseUrl + "/login", {
      waitUntil: "networkidle2",
    });

    // Preenche os campos (ajuste os seletores conforme o HTML da página)
    await page.type('input[type="email"]', this.usuario, { delay: 10 });
    await page.type('input[type="password"]', this.senha, { delay: 10 });

    // Clica no botão de login
    await page.click('button[type="submit"]');

    // Aguarda a navegação ou outro seletor da página logada
    await page.waitForNavigation({ waitUntil: "networkidle2" });

    console.log("Login realizado com sucesso!");


    try {
      await page.waitForSelector('button[aria-label="adicionar agendamento"]', { timeout: 5000 });
      await page.click('button[aria-label="adicionar agendamento"]');
      console.log("✅ Botão de adicionar agendamento encontrado e clicado.");
    } catch {
      console.log("🚨 Botão de adicionar agendamento não encontrado.");
    }


    try {
      await page.waitForSelector('#simple-menu > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-rounded.MuiPaper-elevation8.MuiMenu-paper.MuiPopover-paper.MuiMenu-paper.css-1smm44m > ul > li:nth-child(1) > div.MuiListItemText-root.css-1tsvksn > span', { timeout: 5000 });
      await page.click('#simple-menu > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-rounded.MuiPaper-elevation8.MuiMenu-paper.MuiPopover-paper.MuiMenu-paper.css-1smm44m > ul > li:nth-child(1) > div.MuiListItemText-root.css-1tsvksn > span');
      console.log("✅ Botão de Novo Agendamento encontrado e clicado.");
    } catch {
      console.log("🚨 Botão de Novo Agendamento não encontrado.");
    }


    try {
      // campos input: name="date", name="startTime", cliente será seletor: #downshift-0-input, serviço será seletor: #downshift-1-input, botao salvar: body > div.MuiDialog-root.MuiModal-root.css-126xj0f > div.MuiDialog-container.MuiDialog-scrollPaper.css-ekeie0 > div > form > div.MuiDialogActions-root.MuiDialogActions-spacing.css-145sc4c-actionsRoot > div > button
      await page.waitForSelector('input[name="date"]', { timeout: 5000 });
      await page.type('input[name="date"]', agendamento.data, { delay: 10 });
      console.log("✅ Campo de data encontrado e preenchido.");
    } catch (error) {
      console.log("🚨 Campo de data não encontrado.", error);
    }

    try {
      await page.waitForSelector('input[name="startTime"]', { timeout: 5000 })
      await page.type('input[name="startTime"]', agendamento.hora, { delay: 10 })
      console.log("✅ Campo de hora encontrado e preenchido.")
    }
    catch (error) {
      console.log("🚨 Campo de hora não encontrado.", error);
    }

    //preencher cliente
    try {
      await page.waitForSelector('#downshift-0-input', { timeout: 5000 })
      await page.type('#downshift-0-input', agendamento.telefone, { delay: 10 })

      try {
        // Espera o container da lista
        await page.waitForSelector("#downshift-0-menu", { timeout: 5000 });

        try {
          // Tenta pegar o primeiro <li>
          const clienteItemNode = await page.waitForSelector("#downshift-0-item-0", { timeout: 3000 });
          console.log("clienteItemNode", JSON.stringify(clienteItemNode));

          // Clicou no primeiro <li>
          await clienteItemNode.click();
          console.log("✅ Cliquei no primeiro cliente li da lista");
        } catch (error) {
          console.log(error);
          // Se não encontrou, tenta o botão alternativo
          try {
            const botaoAlternativo = await page.waitForSelector("#downshift-0-menu > div > div > div:nth-child(2) > button", { timeout: 3000 });

            if (botaoAlternativo) {
              await botaoAlternativo.click();
              console.log("✅ Cliquei no botão alternativo para adicionar novo cliente");

              // inicia cadatro de novo cliente

              //input name="name"
              //name="phone1"
              //name="birthDate" se houver o campo dataNascimento no obj agendamento

              // Espera o modal de cadastro de cliente abrir
              await page.waitForSelector('body > div:nth-child(8) > div.MuiDialog-container.MuiDialog-scrollPaper.css-ekeie0 > div > form', { timeout: 5000 });

              //Limpar o campo name antes de digitar
              const inputName = await page.$('input[name="name"]');

              // Limpa o campo
              await inputName.click({ clickCount: 3 }); // seleciona todo o texto
              await page.keyboard.press('Backspace');  // apaga o texto

              // Digita o novo valor
              await inputName.type(agendamento.cliente, { delay: 10 });
              await page.type('input[name="phone1"]', agendamento.telefone, { delay: 10 });
              if (agendamento.dataNascimento) {
                await page.type('input[name="birthDate"]', agendamento.dataNascimento, { delay: 10 });
              }
              //seletor do botaão salvar: body > div:nth-child(8) > div.MuiDialog-container.MuiDialog-scrollPaper.css-ekeie0 > div > form > div.MuiDialogActions-root.MuiDialogActions-spacing.css-145sc4c-actionsRoot > button.MuiButtonBase-root.MuiButton-root.MuiButton-contained.MuiButton-containedPrimary.MuiButton-sizeMedium.MuiButton-containedSizeMedium.MuiButton-root.MuiButton-contained.MuiButton-containedPrimary.MuiButton-sizeMedium.MuiButton-containedSizeMedium.css-1yoits6
              await page.click('body > div:nth-child(8) > div.MuiDialog-container.MuiDialog-scrollPaper.css-ekeie0 > div > form > div.MuiDialogActions-root.MuiDialogActions-spacing.css-145sc4c-actionsRoot > button.MuiButtonBase-root.MuiButton-root.MuiButton-contained.MuiButton-containedPrimary.MuiButton-sizeMedium.MuiButton-containedSizeMedium.MuiButton-root.MuiButton-contained.MuiButton-containedPrimary.MuiButton-sizeMedium.MuiButton-containedSizeMedium.css-1yoits6');
              console.log("✅ Botão de Salvar cliente encontrado e clicado.");
            } else {
              console.log("🚨 Nem li nem botão alternativo foram encontrados");
            }
          } catch (err) {
            console.error("❌ Erro ao tentar encontrar o botão alternativo:", err);
          }
        }
      } catch (err) {
        console.error("❌ Erro ao tentar clicar:", err);
      }
      console.log("✅ Campo de cliente encontrado e preenchido.")
    } catch (error) {
      console.log("🚨 Campo de cliente não encontrado.", error);
    }

    try {
      await page.waitForSelector('#downshift-1-input', { timeout: 5000 })
      await page.type('#downshift-1-input', agendamento.servico, { delay: 10 })
      //Pegar o nome exato da lista de serviços e exibir para o usuario no wpp com numeros;
      //Ao usuario digitar o numero do serviço, guardar o nome exato do serviço;
      //usar esse nome exato para preencher o campo de serviço;
      //clicar no primeiro item da lista que abrir;

      try {
        // Tenta pegar o primeiro <li>
        const servicoItemNode = await page.waitForSelector("#downshift-1-item-0", { timeout: 3000 });
        console.log("serviço item", JSON.stringify(servicoItemNode));

        // Clicou no primeiro <li>
        await servicoItemNode.click();
        console.log("✅ Cliquei no primeiro serviço li da lista");
      } catch {
        console.log("🚨 Não encontrei o primeiro li da lista de serviços.");
        throw new Error("Não encontrei o primeiro li da lista de serviços.");
      }
      console.log("✅ Campo de serviço encontrado e preenchido.")
    } catch (error) {
      console.log("🚨 Campo de serviço não encontrado.", error);
    }

    let retorno = null;

    try {

      await page.waitForSelector('body > div.MuiDialog-root.MuiModal-root.css-126xj0f > div.MuiDialog-container.MuiDialog-scrollPaper.css-ekeie0 > div > form > div.MuiDialogActions-root.MuiDialogActions-spacing.css-145sc4c-actionsRoot > div > button', { timeout: 5000 });
      await page.click('body > div.MuiDialog-root.MuiModal-root.css-126xj0f > div.MuiDialog-container.MuiDialog-scrollPaper.css-ekeie0 > div > form > div.MuiDialogActions-root.MuiDialogActions-spacing.css-145sc4c-actionsRoot > div > button');
      console.log("✅ Botão de Salvar encontrado e clicado.");

      try {
        const agendamentoEncontrado = await this.getAgendamento(agendamento);

        console.log("AAAAAA", JSON.stringify(agendamentoEncontrado))

        if (agendamentoEncontrado.ok) {
          console.log("✅ Agendamento criado com sucesso para:", agendamentoEncontrado?.agendamento?.nome, " no dia:", agendamento?.data, " No horário: ", agendamento?.hora)
          retorno = { ok: true, reason: "Agendamento criado com sucesso.", agendamentoEncontrado: agendamentoEncontrado }
        }
        else {
          console.log("🚨 Não foi possível verificar se o agendamento foi criado.")
          retorno = { ok: false, reason: "Não foi possível verificar se o agendamento foi criado." }
        }
      } catch (error) {
        console.log("🚨 Erro ao verificar se o agendamento foi criado.", error)
        retorno = { ok: false, reason: "Erro ao verificar se o agendamento foi criado." }
      }
    } catch (error) {
      console.log("🚨 Botão de Salvar não encontrado.", error)
      retorno = { ok: false, reason: "Botão de salvar não encontrado." }
    }

    console.log("Fluxo de criação de agendamento finalizado.");
    if (closeBrowser) this.closeBrowser(browser);
    return retorno;
  }

  async getAgendamento(agendamento, closeBrowser = true) {
    console.log("-------------------- Iniciando getAgendamento ---------------------")
    console.log(JSON.stringify(agendamento))

    const browser = await puppeteer.launch({
      headless: false, // mostra o navegador (coloque true se quiser rodar em background)
      defaultViewport: null,
    });
    try {
      const valid = await this.validarDataFutura(agendamento.data, agendamento.hora);
      if (!valid.ok) {
        console.log("🚨 Data ou hora inválida para consulta:", valid.mensagem);
        this.closeBrowser(browser)
        return valid;
      }

      const nome = agendamento.cliente;
      const data = agendamento.data;
      const hora = agendamento.hora;
      const telefone = agendamento.telefone;

      if (!browser) throw new Error("Browser não fornecido");
      if (!nome) throw new Error("Nome não fornecido");
      if (!telefone) throw new Error("Telefone não fornecido");
      console.log("variaveis validadas!")

      /** ---------------------- 1) Abrir página ---------------------- */
      const page = await browser.newPage();
      await page.goto(this.baseUrl + "/login", { waitUntil: "networkidle2" });

      await page.type('input[type="email"]', this.usuario, { delay: 10 });
      await page.type('input[type="password"]', this.senha, { delay: 10 });
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: "networkidle2" });

      console.log("✅ Login realizado. Indo para agenda...");

      await page.goto(`${this.baseUrl}/agenda`, { waitUntil: "networkidle2" });

      /** ---------------------- Auxiliares ---------------------- */
      const limparTel = t => t ? t.replace(/\D/g, "") : "";

      const parseDataBrasil = (str) => {
        const [d, m, y] = str.split("/");
        return new Date(`${y}-${m}-${d}T00:00:00-03:00`);
      };

      /** ✅ Converte dia/mês/ano para string dd/mm/yyyy */
      const toDateString = (date) => {
        const dd = String(date.getDate()).padStart(2, "0");
        const mm = String(date.getMonth() + 1).padStart(2, "0");
        const yyyy = date.getFullYear();
        return `${dd}/${mm}/${yyyy}`;
      };

      /**
       * ✅ Função interna:
       * Selecionar data no calendário e coletar TODOS os agendamentos daquele dia
       */
      const coletarAgendamentosDoDia = async (dia, mes, ano) => {
        console.log(`📅 Coletando agendamentos do dia ${dia}/${mes}/${ano}...`);

        /** 1) Abrir datepicker */
        const dateInputSelector =
          '.MuiInputBase-root.MuiInput-root.MuiInputBase-adornedEnd.Mui-readOnly, ' +
          '.MuiInputBase-root.MuiInput-root.MuiInputBase-adornedEnd.Mui-readOnly input[readonly]';

        await page.waitForSelector(dateInputSelector);
        await page.click(dateInputSelector);

        /** 2) Obter mês/ano atuais */
        const headerSelector = ".MuiPickersCalendarHeader-label";
        await page.waitForSelector(headerSelector);

        const headerText = await page.$eval(headerSelector, el => el.textContent.trim());
        let [mesAtualNome, anoAtualStr] = headerText.split(" ");
        let mesAtual = await this.monthNameToNumber(mesAtualNome);
        let anoAtual = parseInt(anoAtualStr);

        const clicksNeeded = await this.monthsDiff(mesAtual, anoAtual, mes, ano);

        const nextButton = 'button[aria-label="Next month"]';
        await page.waitForSelector(nextButton);

        for (let i = 0; i < clicksNeeded; i++) {
          await page.click(nextButton);
          await new Promise(r => setTimeout(r, 200));
        }

        /** 4) Selecionar o dia */
        const buttons = await page.$$("button");
        let targetBtn = null;

        for (const btn of buttons) {
          const txt = await page.evaluate(el => el.textContent.trim(), btn);
          if (txt === String(dia)) {
            targetBtn = btn;
            break;
          }
        }

        if (!targetBtn) {
          console.log("❌ Botão do dia não encontrado.");
          return [];
        }

        await targetBtn.click();

        /** 5) Click em OK */
        const okButtons = await page.$$("button");
        for (const btn of okButtons) {
          const txt = await page.evaluate(el => el.textContent.trim().toUpperCase(), btn);
          if (txt === "OK") {
            await btn.click();
            break;
          }
        }

        await new Promise(r => setTimeout(r, 800));

        /** 6) Coletar eventos */
        const eventos = await page.$$(".fc-time-grid-event");
        console.log(`🔍 Encontrados ${eventos.length} agendamentos.`);
        console.log("agendamentos: ", JSON.stringify(eventos))

        const resultados = [];

        for (const ev of eventos) {
          await page.evaluate(el => el.click(), ev);
          await page.waitForSelector(".MuiDialog-paper", { timeout: 5000 });

          const dados = await page.evaluate(() => {
            const modal = document.querySelector(".MuiDialog-paper");

            const q = sel => modal.querySelector(sel);
            const qa = sel => [...modal.querySelectorAll(sel)];

            return {
              horario: q(".MuiListItemText-primary")?.textContent.trim() || null,
              nome: q(".MuiListItemText-root p.MuiTypography-body1")?.textContent.trim() || null,
              telefone: q(".css-cl5ei2-phoneTile")?.textContent.trim() || null,
              servico: qa("nav .MuiListItemText-primary")[1]?.textContent.trim() || null,
              valor: qa("nav .MuiListItemText-secondary")[1]?.textContent.trim() || null,
              formaPagamento: qa("nav .MuiListItemText-secondary")[2]?.textContent.trim() || null,
              observacao: qa("nav .MuiListItemText-secondary")[3]?.textContent.trim() || null,
              status: qa("nav .MuiListItemText-secondary")[4]?.textContent.trim() || null
            };
          });

          /** Fechar modal */
          const fechar = await page.$$('button');
          let closed = false;

          for (const btn of fechar) {
            const txt = await page.evaluate(el => el.textContent.trim().toUpperCase(), btn);
            if (txt === "FECHAR") {
              await btn.click();
              closed = true;
              break;
            }
          }

          if (!closed) await page.keyboard.press("Escape");

          resultados.push(dados);
          await new Promise(r => setTimeout(r, 200));
        }

        console.log("agendamentos do dia:", JSON.stringify(resultados))

        return resultados;
      }

      /** ---------------------- 7) Buscar dia exato ---------------------- */
      const dataBase = parseDataBrasil(data);

      const eventosDia = await coletarAgendamentosDoDia(
        dataBase.getDate(),
        dataBase.getMonth() + 1,
        dataBase.getFullYear()
      );

      /** 8) Procurar agendamento exato */
      const encontrado = eventosDia.find(a =>
        limparTel(a.telefone).endsWith(limparTel(telefone)) &&
        a.horario?.startsWith(hora)
      );

      if (encontrado) {
        console.log("Agendamento encontrado!", JSON.stringify(encontrado))
        if (closeBrowser) await this.closeBrowser(browser)
        return { ok: true, agendamento: encontrado }
      }

      console.log("❌ Agendamento exato não encontrado. Buscando próximos...");

      /** ---------------------- 9) Buscar ±3 dias ---------------------- */
      const proximos = [];

      for (let i = -3; i <= 3; i++) {
        if (i === 0) continue;

        const aux = new Date(dataBase);
        aux.setDate(aux.getDate() + i);

        const lista = await coletarAgendamentosDoDia(
          aux.getDate(),
          aux.getMonth() + 1,
          aux.getFullYear()
        );

        for (const a of lista) {
          if (limparTel(a.telefone).endsWith(limparTel(telefone))) {
            proximos.push({
              ...a,
              data: toDateString(aux)
            });
          }
        }
      }

      if (proximos.length > 0) {
        console.log("Agendamento exato não encontrado. Agendamentos do cliente próximos a essa data: ", JSON.stringify(proximos))
        if (closeBrowser) await this.closeBrowser(browser)
        return {
          ok: false,
          motivo: "Agendamento exato não encontrado.",
          proximos
        };
      }

      console.log("Nenhum agendamento encontrado para este cliente proximo ao dia: ", dia)
      if (closeBrowser) await this.closeBrowser(browser)
      return {
        ok: false,
        motivo: "Nenhum agendamento encontrado para este cliente."
      };

    } catch (err) {
      console.log("❌ Erro no getAgendamento:", err);
      if (closeBrowser) await this.closeBrowser(browser)
      return { ok: false, motivo: "Erro interno." };
    }
  }

  async getServicosComDescricao() {
    const browser = await puppeteer.launch({
      headless: false, // mostra o navegador (coloque true se quiser rodar em background)
      defaultViewport: null,
    });
    const page = await browser.newPage();
    await page.goto(this.baseUrl, {
      waitUntil: "networkidle2",
    });

    // Preenche os campos (ajuste os seletores conforme o HTML da página)
    await page.type('input[type="email"]', this.usuario, { delay: 10 });
    await page.type('input[type="password"]', this.senha, { delay: 10 });

    // Clica no botão de login
    await page.click('button[type="submit"]');

    // Aguarda a navegação ou outro seletor da página logada
    await page.waitForNavigation({ waitUntil: "networkidle2" });

    console.log("Login realizado com sucesso!");

    // Acessa a página de serviços
    await page.goto(`${this.baseUrl}/servicos`, {
      waitUntil: "networkidle2",
    });

    // Espera a tabela de serviços carregar
    // Altera a quantidade de serviços exibidos para 50 (ultimo item da lista do select dropdown)
    // Para alterar, clique no seletor de quantidade de serviços exibidos: #\:r19\:
    // selecione o último item da lista (50)
    // Espera a tabela de serviços carregar novamente
    // Pega todos os nomes de serviços exibidos na tabela
    // Para pegar os nomes, use o seletor: #infiniteScrollDiv > div:nth-child(2) > div > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-elevation1.css-g73cc8 > div.css-zwft14-content > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-rounded.MuiPaper-elevation1.MuiCard-root.css-12nolks-root > div.MuiCardContent-root.css-1p9cd3b-content > div > div:nth-child(1) > table > tbody > tr:nth-child(28) > td:nth-child(1) > div > div.css-1keoiy0-cellNameColumnValue
    // Para cada linha da tabela, pegue o texto do elemento que contém o nome do serviço


    await page.waitForSelector('#infiniteScrollDiv > div:nth-child(2) > div > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-elevation1.css-g73cc8 > div.css-zwft14-content > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-rounded.MuiPaper-elevation1.MuiCard-root.css-12nolks-root > div.MuiCardActions-root.MuiCardActions-spacing.css-11ah5ux-actions > div > div > div.MuiInputBase-root.MuiInputBase-colorPrimary.MuiTablePagination-input.css-fml6nx', { timeout: 5000 });
    await page.click('#infiniteScrollDiv > div:nth-child(2) > div > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-elevation1.css-g73cc8 > div.css-zwft14-content > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-rounded.MuiPaper-elevation1.MuiCard-root.css-12nolks-root > div.MuiCardActions-root.MuiCardActions-spacing.css-11ah5ux-actions > div > div > div.MuiInputBase-root.MuiInputBase-colorPrimary.MuiTablePagination-input.css-fml6nx');
    await page.waitForSelector('#menu- > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-rounded.MuiPaper-elevation8.MuiMenu-paper.MuiPopover-paper.MuiMenu-paper.css-1smm44m > ul > li:nth-child(3)', { timeout: 5000 });
    await page.click('#menu- > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-rounded.MuiPaper-elevation8.MuiMenu-paper.MuiPopover-paper.MuiMenu-paper.css-1smm44m > ul > li:nth-child(3)');
    await page.waitForSelector('#infiniteScrollDiv > div:nth-child(2) > div > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-elevation1.css-g73cc8 > div.css-zwft14-content > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-rounded.MuiPaper-elevation1.MuiCard-root.css-12nolks-root > div.MuiCardContent-root.css-1p9cd3b-content > div > div:nth-child(1) > table', { timeout: 5000 });
    console.log("Tabela de serviços carregada, extraindo nomes...");
    // Lógica para extrair os nomes dos serviços
    const servicos = [];

    await new Promise(r => setTimeout(r, 2000)); // espera 2 segundos para garantir que a tabela carregou

    const rows = await page.$$('#infiniteScrollDiv tbody tr.MuiTableRow-hover');

    console.log(`Encontradas ${rows.length} linhas de serviços.`);

    for (const row of rows) {
      await row.click();
      console.log(row);
      console.log("Clicou em uma linha de serviço para abrir o modal de detalhes.");
      await new Promise(r => setTimeout(r, 500)); // espera meio segundo

      const servico = await page.evaluate(() => {
        const normalizeKey = (text) =>
          text
            .normalize("NFD")                 // separa acento da letra
            .replace(/[\u0300-\u036f]/g, "")  // remove os acentos
            .toLowerCase()
            .trim();


        const titulos = document.querySelectorAll(
          'nav.MuiList-root li .MuiTypography-body1'
        );
        const conteudos = document.querySelectorAll(
          'nav.MuiList-root li .MuiTypography-body2'
        );

        const obj = {};

        console.log('Nome: ', conteudos[0].innerText);

        titulos.forEach((tituloEl, idx) => {
          const rawKey = tituloEl.innerText;
          const key = normalizeKey(rawKey);

          if (
            ["descricao", "nome", "duracao", "preco"].some(t =>
              key.includes(t)
            )
          ) {
            obj[key] = conteudos[idx]
              ? conteudos[idx].innerText.trim()
              : null;
          }
        });

        return obj;
      });

      servicos.push(servico);

      const fechar = await page.$('.MuiDialogActions-root button.MuiButton-textPrimary');

      if (fechar) {
        await fechar.click();
        console.log("Fechou o modal de detalhes do serviço.");
      }

      await new Promise(r => setTimeout(r, 500)); // espera meio segundo

    }

    console.log("Serviços encontrados:", servicos);

    this.closeBrowser(browser); // fecha o navegador após a extração
    return servicos;
  }

  async getServicos() {
    const browser = await puppeteer.launch({
      headless: false, // mostra o navegador (coloque true se quiser rodar em background)
      defaultViewport: null,
    });
    const page = await browser.newPage();
    await page.goto(this.baseUrl, {
      waitUntil: "networkidle2",
    });

    // Preenche os campos (ajuste os seletores conforme o HTML da página)
    await page.type('input[type="email"]', this.usuario, { delay: 10 });
    await page.type('input[type="password"]', this.senha, { delay: 10 });

    // Clica no botão de login
    await page.click('button[type="submit"]');

    // Aguarda a navegação ou outro seletor da página logada
    await page.waitForNavigation({ waitUntil: "networkidle2" });

    console.log("Login realizado com sucesso!");

    // Acessa a página de serviços
    await page.goto(`${this.baseUrl}/servicos`, {
      waitUntil: "networkidle2",
    });

    // Espera a tabela de serviços carregar
    // Altera a quantidade de serviços exibidos para 50 (ultimo item da lista do select dropdown)
    // Para alterar, clique no seletor de quantidade de serviços exibidos: #\:r19\:
    // selecione o último item da lista (50)
    // Espera a tabela de serviços carregar novamente
    // Pega todos os nomes de serviços exibidos na tabela
    // Para pegar os nomes, use o seletor: #infiniteScrollDiv > div:nth-child(2) > div > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-elevation1.css-g73cc8 > div.css-zwft14-content > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-rounded.MuiPaper-elevation1.MuiCard-root.css-12nolks-root > div.MuiCardContent-root.css-1p9cd3b-content > div > div:nth-child(1) > table > tbody > tr:nth-child(28) > td:nth-child(1) > div > div.css-1keoiy0-cellNameColumnValue
    // Para cada linha da tabela, pegue o texto do elemento que contém o nome do serviço


    await page.waitForSelector('#infiniteScrollDiv > div:nth-child(2) > div > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-elevation1.css-g73cc8 > div.css-zwft14-content > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-rounded.MuiPaper-elevation1.MuiCard-root.css-12nolks-root > div.MuiCardActions-root.MuiCardActions-spacing.css-11ah5ux-actions > div > div > div.MuiInputBase-root.MuiInputBase-colorPrimary.MuiTablePagination-input.css-fml6nx', { timeout: 5000 });
    await page.click('#infiniteScrollDiv > div:nth-child(2) > div > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-elevation1.css-g73cc8 > div.css-zwft14-content > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-rounded.MuiPaper-elevation1.MuiCard-root.css-12nolks-root > div.MuiCardActions-root.MuiCardActions-spacing.css-11ah5ux-actions > div > div > div.MuiInputBase-root.MuiInputBase-colorPrimary.MuiTablePagination-input.css-fml6nx');
    await page.waitForSelector('#menu- > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-rounded.MuiPaper-elevation8.MuiMenu-paper.MuiPopover-paper.MuiMenu-paper.css-1smm44m > ul > li:nth-child(3)', { timeout: 5000 });
    await page.click('#menu- > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-rounded.MuiPaper-elevation8.MuiMenu-paper.MuiPopover-paper.MuiMenu-paper.css-1smm44m > ul > li:nth-child(3)');
    await page.waitForSelector('#infiniteScrollDiv > div:nth-child(2) > div > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-elevation1.css-g73cc8 > div.css-zwft14-content > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-rounded.MuiPaper-elevation1.MuiCard-root.css-12nolks-root > div.MuiCardContent-root.css-1p9cd3b-content > div > div:nth-child(1) > table', { timeout: 5000 });
    console.log("Tabela de serviços carregada, extraindo nomes...");
    // Lógica para extrair os nomes dos serviços
    const servicos = await page.evaluate(() => {
      const servicoElements = document.querySelectorAll('#infiniteScrollDiv > div:nth-child(2) > div > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-elevation1.css-g73cc8 > div.css-zwft14-content > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-rounded.MuiPaper-elevation1.MuiCard-root.css-12nolks-root > div.MuiCardContent-root.css-1p9cd3b-content > div > div:nth-child(1) > table > tbody tr td:nth-child(1) .css-1keoiy0-cellNameColumnValue');
      const duracaoElements = document.querySelectorAll('#infiniteScrollDiv > div:nth-child(2) > div > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-elevation1.css-g73cc8 > div.css-zwft14-content > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-rounded.MuiPaper-elevation1.MuiCard-root.css-12nolks-root > div.MuiCardContent-root.css-1p9cd3b-content > div > div:nth-child(1) > table > tbody tr td:nth-child(2)');
      const precoElements = document.querySelectorAll('#infiniteScrollDiv > div:nth-child(2) > div > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-elevation1.css-g73cc8 > div.css-zwft14-content > div.MuiPaper-root.MuiPaper-elevation.MuiPaper-rounded.MuiPaper-elevation1.MuiCard-root.css-12nolks-root > div.MuiCardContent-root.css-1p9cd3b-content > div > div:nth-child(1) > table > tbody tr td:nth-child(3)');
      const servicos = [];
      servicoElements.forEach((el, index) => {
        servicos.push({
          nome: el.innerText.trim(),
          duracao: duracaoElements[index] ? duracaoElements[index].innerText.trim() : null,
          preco: precoElements[index] ? precoElements[index].innerText.trim() : null,
        });
      });
      return servicos;
    });

    console.log("Serviços encontrados:", servicos);

    this.closeBrowser(browser); // fecha o navegador após a extração
    return servicos;
  }

  async updateAgendamento(agendamentoAntigo, agendamentoNovo, closeBrowser = true) {
    console.log(" -------------------- Iniciando updateAgendamento ---------------------")
    console.log("Agendamento Antigo:", JSON.stringify(agendamentoAntigo))
    console.log("Agendamento Novo:", JSON.stringify(agendamentoNovo))

    // Validar se a data e hora são futuras
    const dataValida = await this.validarDataFutura(agendamentoNovo.data, agendamentoNovo.hora);
    if (dataValida.ok === false) {
      console.log("🚨 Data ou hora inválida para agendamento:", dataValida.reason)
      return dataValida
    }

    const browser = await puppeteer.launch({
      headless: false, // mostra o navegador (coloque true se quiser rodar em background)
      defaultViewport: null,
    });

    //1 checar conflito do novo hoario

    const horarioDisponivel = await this.checarConflitoOuSugerirHorariosAlternativos(agendamentoNovo)

    if (horarioDisponivel) {
      if (horarioDisponivel.ok === false) {
        console.log("🚨 Não é possível agendar nesse horario por conflito de agenda. Horarios disponíveis para esse procedimento nos proximos dias: ",
          JSON.stringify(horarioDisponivel.diasAlternativos).trim() ?? "Sem horario nos proximos 365 dias.")
        if (closeBrowser) this.closeBrowser(browser);
        return { ok: false, reason: "Não é possível agendar nesse horario por conflito de agenda.", diasAlternativos: horarioDisponivel.diasAlternativos ?? [] }
      }
    }


    //2 checar existencia do agendamento antigo

    const agendamentoExistente = await this.getAgendamento(agendamentoAntigo, false);
    console.log("Agendamento existente verificado:", JSON.stringify(agendamentoExistente))

    if (!agendamentoExistente?.agendamento && agendamentoExistente?.proximos?.length > 0) {
      return agendamentoExistente;
    }

    if (agendamentoExistente.ok === false) {
      console.log("🚨 Agendamento antigo não encontrado, não é possível atualizar.", JSON.stringify(agendamentoExistente))
      if (closeBrowser) this.closeBrowser(browser);
      return { ok: false, reason: "Agendamento antigo não encontrado, não é possível atualizar." }
    }

    //3 criar o novo agendamento

    const criarNovo = await this.setAgendamento(agendamentoNovo, false);

    if (criarNovo.ok === false) {
      console.log("🚨 Não foi possível criar o novo agendamento.", JSON.stringify(criarNovo))
      if (closeBrowser) this.closeBrowser(browser);
      return { ok: false, reason: "Não foi possível criar o novo agendamento." }
    }
    console.log("✅ Novo agendamento criado com sucesso.")


    //4 deletar o agendamento antigo

    const deletarAntigo = await this.deletarAgendamento(agendamentoAntigo, false);

    if (deletarAntigo.ok === false) {
      console.log("🚨 Não foi possível deletar o agendamento antigo.", JSON.stringify(deletarAntigo))
      if (closeBrowser) this.closeBrowser(browser);
      return { ok: false, reason: "Não foi possível deletar o agendamento antigo." }
    }
    console.log("✅ Agendamento antigo deletado com sucesso.")

    console.log("✅ Update de agendamento realizado com sucesso.")
    if (closeBrowser) this.closeBrowser(browser);
    return { ok: true, reason: "Update de agendamento realizado com sucesso." }
  }

  async deletarAgendamento(agendamento, closeBrowser = true) {
    console.log("-------------------- Iniciando deletarAgendamento ---------------------");
    console.log(JSON.stringify(agendamento));

    const browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
    });

    try {
      /** ---------------------- 0) Validações ---------------------- */
      const valid = await this.validarDataFutura(agendamento.data, agendamento.hora);
      if (!valid.ok) {
        console.log("🚨 Data ou hora inválida:", valid.mensagem);
        if (closeBrowser) await this.closeBrowser(browser);
        return valid;
      }

      const { cliente: nome, data, hora, telefone } = agendamento;
      if (!nome || !telefone) throw new Error("Dados obrigatórios não fornecidos");

      /** ---------------------- 1) Login ---------------------- */
      const page = await browser.newPage();
      await page.goto(this.baseUrl + "/login", { waitUntil: "networkidle2" });
      await page.type('input[type="email"]', this.usuario, { delay: 10 });
      await page.type('input[type="password"]', this.senha, { delay: 10 });
      await page.click('button[type="submit"]');
      await page.waitForNavigation({ waitUntil: "networkidle2" });

      console.log("✅ Login realizado. Indo para agenda...");
      await page.goto(`${this.baseUrl}/agenda`, { waitUntil: "networkidle2" });

      /** ---------------------- 2) Verificar existência ---------------------- */
      const existente = await this.getAgendamento(agendamento, false);

      if (!existente?.agendamento) {
        console.log("🚨 Agendamento não encontrado para deleção.");
        if (closeBrowser) await this.closeBrowser(browser);
        return {
          ok: false,
          motivo: "Agendamento não encontrado, não é possível deletar.",
          proximos: existente?.proximos ?? []
        };
      }

      console.log("🧾 Agendamento encontrado. Iniciando deleção...");

      /** ---------------------- 3) Abrir o modal do agendamento ---------------------- */

      const limparTel = t => t ? t.replace(/\D/g, "") : "";

      // reutiliza lógica do getAgendamento
      const dataBase = (() => {
        const [d, m, y] = data.split("/");
        return new Date(`${y}-${m}-${d}T00:00:00-03:00`);
      })();

      const coletar = async () => {
        // abre o calendário e seleciona o dia (mesma lógica do getAgendamento)
        const dateInputSelector =
          '.MuiInputBase-root.MuiInput-root.MuiInputBase-adornedEnd.Mui-readOnly, ' +
          '.MuiInputBase-root.MuiInput-root.MuiInputBase-adornedEnd.Mui-readOnly input[readonly]';

        await page.waitForSelector(dateInputSelector);
        await page.click(dateInputSelector);

        const headerSelector = ".MuiPickersCalendarHeader-label";
        await page.waitForSelector(headerSelector);
        const headerText = await page.$eval(headerSelector, el => el.textContent.trim());
        const [mesNome, anoStr] = headerText.split(" ");
        const mesAtual = await this.monthNameToNumber(mesNome);
        const anoAtual = parseInt(anoStr);

        const clicks = await this.monthsDiff(
          mesAtual,
          anoAtual,
          dataBase.getMonth() + 1,
          dataBase.getFullYear()
        );

        for (let i = 0; i < clicks; i++) {
          await page.click('button[aria-label="Next month"]');
          await new Promise(r => setTimeout(r, 200));
        }

        const buttons = await page.$$("button");
        for (const btn of buttons) {
          const txt = await page.evaluate(el => el.textContent.trim(), btn);
          if (txt === String(dataBase.getDate())) {
            await btn.click();
            break;
          }
        }

        for (const btn of buttons) {
          const txt = await page.evaluate(el => el.textContent.trim().toUpperCase(), btn);
          if (txt === "OK") {
            await btn.click();
            break;
          }
        }

        await new Promise(r => setTimeout(r, 800));
      };

      await coletar();

      /** ---------------------- 4) Abrir evento correto ---------------------- */
      const eventos = await page.$$(".fc-time-grid-event");

      for (const ev of eventos) {
        await page.evaluate(el => el.click(), ev);
        await page.waitForSelector(".MuiDialog-paper", { timeout: 5000 });

        const dados = await page.evaluate(() => {
          const modal = document.querySelector(".MuiDialog-paper");
          const q = sel => modal.querySelector(sel);
          return {
            horario: q(".MuiListItemText-primary")?.textContent.trim(),
            telefone: q(".css-cl5ei2-phoneTile")?.textContent.trim()
          };
        });

        if (
          dados?.horario?.startsWith(hora) &&
          limparTel(dados?.telefone).endsWith(limparTel(telefone))
        ) {
          console.log("🗑️ Agendamento correto aberto. Deletando...");

          /** ---------------------- 5) Deletar ---------------------- */
          const botoes = await page.$$("button");
          for (const btn of botoes) {
            const txt = await page.evaluate(el => el.textContent.trim().toUpperCase(), btn);
            if (txt === "DELETAR" || txt === "EXCLUIR") {
              await btn.click();
              break;
            }
          }

          await page.waitForTimeout(500);

          /** Confirmar deleção */
          const confirmBtns = await page.$$("button");
          for (const btn of confirmBtns) {
            const txt = await page.evaluate(el => el.textContent.trim().toUpperCase(), btn);
            if (txt === "CONFIRMAR" || txt === "OK" || txt === "SIM") {
              await btn.click();
              break;
            }
          }

          console.log("✅ Agendamento deletado com sucesso.");
          if (closeBrowser) await this.closeBrowser(browser);
          return { ok: true };
        }

        // fecha modal se não for o correto
        await page.keyboard.press("Escape");
        await new Promise(r => setTimeout(r, 200));
      }

      console.log("❌ Não foi possível localizar o agendamento no dia.");
      if (closeBrowser) await this.closeBrowser(browser);
      return { ok: false, motivo: "Agendamento não localizado para deleção." };

    } catch (err) {
      console.log("❌ Erro no deletarAgendamento:", err);
      if (closeBrowser) await this.closeBrowser(browser);
      return { ok: false, motivo: "Erro interno." };
    }
  }

  monthNameToNumber(name) {
    const map = {
      janeiro: 1, fevereiro: 2, março: 3, marco: 3, abril: 4,
      maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9,
      outubro: 10, novembro: 11, dezembro: 12
    };
    return map[(name || '').toLowerCase()] || null;
  }

  monthsDiff(currentMonth, currentYear, targetMonth, targetYear) {
    return (targetYear - currentYear) * 12 + (targetMonth - currentMonth);
  }

  timeToMinutes(t) {
    if (!t) return null;
    const [h, m] = t.split(':').map(n => parseInt(n.trim(), 10));
    return h * 60 + m;
  }

  minutesToTimeString(min) {
    const h = Math.floor(min / 60).toString().padStart(2, '0');
    const m = (min % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
  }

  parseDateDDMMYYYY(str) {
    const [dd, mm, yyyy] = (str || '').split('/').map(x => parseInt(x, 10));
    return new Date(yyyy, mm - 1, dd);
  }

  formatDateDDMMYYYY(date) {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  }

  async closeBrowser(browser) {
    try {
      if (browser && browser.connected) await browser.close();
    } catch (err) {
      console.warn('⚠️ Erro ao fechar browser:', err?.message || err);
    }
  }

  /* -------------------------
     CALENDAR HELPERS
     ------------------------- */

  // Abre o datepicker de forma segura
  async abrirDatePicker(page) {
    const dateInputSelector =
      '.MuiInputBase-root.MuiInput-root.MuiInputBase-adornedEnd.Mui-readOnly, ' +
      '.MuiInputBase-root.MuiInput-root.MuiInputBase-adornedEnd.Mui-readOnly input[readonly]';
    await page.waitForSelector(dateInputSelector, { timeout: 7000 });
    await page.click(dateInputSelector);
    // esperar transição do MUI
    await page.waitForSelector('.MuiPickersSlideTransition-root', { timeout: 7000 }).catch(() => { });
    await new Promise(r => setTimeout(r, 150));
  }

  // Navega o datepicker até o mês/ano do lookDate (retorna true se ok, false se clicks < 0)
  async goToMonthYear(page, lookDate, headerSelector = '.MuiPickersCalendarHeader-label', nextButtonSelector = 'button[title="Next month"], button[aria-label="Next month"]') {
    try {
      await page.waitForSelector(headerSelector, { timeout: 7000 });

      const targetMonth = lookDate.getMonth() + 1;
      const targetYear = lookDate.getFullYear();

      let headerText = await page.$eval(headerSelector, el => el.textContent.trim());
      let [mesAtualNome, anoAtualStr] = headerText.split(" ");

      let mesAtual = this.monthNameToNumber(mesAtualNome);
      let anoAtual = parseInt(anoAtualStr, 10);

      const clicks = this.monthsDiff(mesAtual, anoAtual, targetMonth, targetYear);
      if (clicks < 0) {
        console.log('⚠️ goToMonthYear: target mês é anterior; não fazemos retrocesso.');
        return false;
      }

      await page.waitForSelector(nextButtonSelector, { timeout: 7000 });
      for (let i = 0; i < clicks; i++) {
        await page.click(nextButtonSelector);
        await new Promise(r => setTimeout(r, 200));
      }

      return true;
    } catch (err) {
      console.log('❌ Erro em goToMonthYear:', err?.message || err);
      return false;
    }
  }

  // Seleciona o dia no calendário (usa regra C: se múltiplos, se day < 15 pega primeiro, senão pega segundo)
  async selectDayInCalendar(page, dayNumber) {
    try {
      const allButtons = await page.$$('button');
      const candidateButtons = [];
      for (const btn of allButtons) {
        const span = await btn.$('span');
        if (!span) continue;
        let txt = await (await span.getProperty('textContent')).jsonValue();
        if (!txt) continue;
        txt = txt.replace(/\s+/g, '');
        if (txt === String(dayNumber)) candidateButtons.push(btn);
      }

      if (candidateButtons.length === 0) return false;

      let chosenBtn;
      if (candidateButtons.length === 1) chosenBtn = candidateButtons[0];
      else if (dayNumber < 15) chosenBtn = candidateButtons[0];
      else chosenBtn = candidateButtons[1] ?? candidateButtons[0];

      await chosenBtn.click();

      // Clicar OK se existir
      const okButtons = await page.$$('button');
      for (const btn of okButtons) {
        const txt = await (await btn.getProperty('textContent')).jsonValue();
        if (txt && String(txt).trim().toUpperCase() === 'OK') {
          await btn.click();
          break;
        }
      }

      await new Promise(res => setTimeout(res, 300));
      return true;
    } catch (err) {
      console.log('❌ Erro em selectDayInCalendar:', err?.message || err);
      return false;
    }
  }

  // Coleta intervalos do dia rápido (sem abrir modal). Retorna [{start, end}, ...]
  async collectBookedIntervalsForDay(page) {
    try {
      await new Promise(r => setTimeout(r, 300));
      // event handles
      const eventos = await page.$$('.fc-time-grid-event');
      const intervals = [];

      for (let i = 0; i < eventos.length; i++) {
        const evento = eventos[i];

        // tenta extrair texto do próprio evento
        let horarioText = null;
        horarioText = await evento.$eval('.fc-time', el => el.textContent).catch(() => null)
          || await evento.$eval('span', el => el.textContent).catch(() => null)
          || null;

        if (!horarioText) {
          // fallback: abrir modal rapidamente
          await evento.click().catch(() => { });
          await page.waitForSelector('.MuiDialog-paper', { timeout: 1500 }).catch(() => { });
          horarioText = await page.$eval('.MuiDialog-paper .MuiListItemText-primary', el => el.textContent).catch(() => null);
          // fechar modal se abriu
          const fecharButtons = await page.$$('button');
          for (const btn of fecharButtons) {
            const txt = await (await btn.getProperty('textContent')).jsonValue().catch(() => null);
            if (txt && String(txt).trim().toUpperCase() === 'FECHAR') {
              await btn.click().catch(() => { });
              break;
            }
          }
          await new Promise(r => setTimeout(r, 200));
        }

        if (!horarioText) continue;

        // normalizar: "09:00 - 10:00" ou "09:00"
        const parts = horarioText.split('-').map(s => s.trim());
        const start = this.timeToMinutes(parts[0].slice(0, 5));
        const end = parts[1] ? this.timeToMinutes(parts[1].slice(0, 5)) : (start + 60);
        if (start != null && end != null) intervals.push({ start, end });
      }

      intervals.sort((a, b) => a.start - b.start);
      return intervals;
    } catch (err) {
      console.log('❌ Erro em collectBookedIntervalsForDay:', err?.message || err);
      return [];
    }
  }

  // Método mais completo: extrai eventos do dia abrindo modal e retornando objetos detalhados
  async extrairEventosDoDia(page) {
    async function clickBringToFront(page, elementHandle) {
      await page.evaluate(el => {
        el.dataset.originalZ = window.getComputedStyle(el).zIndex;
        el.style.zIndex = 9999999;
        el.style.position = 'relative';
      }, elementHandle);

      await page.evaluate(el => el.click(), elementHandle);

      await page.evaluate(el => {
        if (el.dataset.originalZ && el.dataset.originalZ !== 'auto') el.style.zIndex = el.dataset.originalZ;
        else el.style.zIndex = '';
        el.style.position = '';
      }, elementHandle);
    }

    try {
      const eventos = await page.$$('.fc-time-grid-event');
      const lista = [];

      for (let i = 0; i < eventos.length; i++) {
        const evento = eventos[i];
        await clickBringToFront(page, evento);
        await page.waitForSelector('.MuiDialog-paper', { timeout: 5000 }).catch(() => { });
        const modal = await page.$('.MuiDialog-paper');
        if (!modal) {
          // não abriu modal, pular
          continue;
        }

        const dados = await page.evaluate(modal => {
          const q = sel => modal.querySelector(sel);
          const qa = sel => Array.from(modal.querySelectorAll(sel));
          const horario = q('.MuiListItemText-primary')?.textContent.trim() || null;
          const nome = q('.MuiListItemText-root p.MuiTypography-body1')?.textContent.trim() || null;
          const telefone = q('.css-cl5ei2-phoneTile')?.textContent.trim() || null;
          const servico = qa('nav .MuiListItemText-primary')[1]?.textContent.trim() || null;
          const valor = qa('nav .MuiListItemText-secondary')[1]?.textContent.trim() || null;
          const formaPagamento = qa('nav .MuiListItemText-secondary')[2]?.textContent.trim() || null;
          const observacao = qa('nav .MuiListItemText-secondary')[3]?.textContent.trim() || null;
          const status = qa('nav .MuiListItemText-secondary')[4]?.textContent.trim() || null;
          return { horario, nome, telefone, servico, valor, formaPagamento, observacao, status };
        }, modal);

        // fechar modal
        const fecharButtons = await page.$$('button');
        let fechado = false;
        for (const btn of fecharButtons) {
          const txt = await (await btn.getProperty('textContent')).jsonValue().catch(() => null);
          if (txt && String(txt).trim().toUpperCase() === 'FECHAR') {
            await btn.click().catch(() => { });
            fechado = true;
            break;
          }
        }
        if (!fechado) await page.keyboard.press('Escape').catch(() => { });

        // parse horario
        let start = null, end = null;
        if (dados.horario) {
          const m = dados.horario.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
          if (m) { start = this.timeToMinutes(m[1]); end = this.timeToMinutes(m[2]); }
        }

        lista.push({ ...dados, start, end });
        await new Promise(r => setTimeout(r, 250));
      }

      return lista;
    } catch (err) {
      console.log('❌ Erro em extrairEventosDoDia:', err?.message || err);
      return [];
    }
  }

  async selecionarData(page, dateObj) {
    try {

      if (!(dateObj instanceof Date)) {
        dateObj = this.parseDateDDMMYYYY(dateObj);
      }

      // abrir datepicker
      await this.abrirDatePicker(page);

      // ir para o mês/ano correto
      const ok = await this.goToMonthYear(
        page,
        dateObj,
        '.MuiPickersCalendarHeader-label',
        'button[title="Next month"], button[aria-label="Next month"]'
      );
      if (!ok) {
        console.log("⚠️ selecionarData: Não foi possível navegar até mês/ano desejado.");
        return false;
      }

      // selecionar dia (regra C)
      const day = dateObj.getDate();
      const selected = await this.selectDayInCalendar(page, day);
      if (!selected) {
        console.log("⚠️ selecionarData: Não foi possível selecionar o dia.");
        return false;
      }

      // esperar agenda carregar
      await page.waitForSelector('.fc-body', { timeout: 7000 }).catch(() => { });
      await page.waitForTimeout(300);

      return true;

    } catch (err) {
      console.log("❌ Erro em selecionarData:", err?.message || err);
      return false;
    }
  }

}