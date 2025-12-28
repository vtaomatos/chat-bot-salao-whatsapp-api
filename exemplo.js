import { MinhaAgendaRepository } from "./minha_agenda_repository.js";
import puppeteer from "puppeteer";
import dotenv from "dotenv"

dotenv.config()

const repo = new MinhaAgendaRepository({
  usuario: process.env.MINHA_AGENDA_USER,
  senha: process.env.MINHA_AGENDA_SENHA
});


(async () => {
  const agendamento = {
    cliente: "TESTE BOT Maria Silva",
    telefone: "11999999999",
    servico: "box braids",
    duracaoMinutos: 240,
    data: "06/11/2025",
    hora: "17:00",
    dataNascimento: "06/05/1990"
  }

  // repo.setAgendamento(agendamento)
  // repo.getServicos()
  repo.getServicosComDescricao()

  // repo.checarConflitosAgendamento(browser, agendamento)
  // repo.getAgendamento(browser, agendamento)
  // repo.checarConflitoOuSugerirHorariosAlternativos(browser, agendamento)
  return;
})();
