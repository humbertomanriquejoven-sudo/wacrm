import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aiTimeZone,
  buildSystemPrompt,
  currentDateTimeContext,
  todayContextLine,
} from './defaults';

const REAL_TZ = process.env.AI_TIMEZONE;

beforeEach(() => {
  process.env.AI_TIMEZONE = 'America/Bogota';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  if (REAL_TZ === undefined) {
    delete process.env.AI_TIMEZONE;
  } else {
    process.env.AI_TIMEZONE = REAL_TZ;
  }
});

describe('currentDateTimeContext', () => {
  it('computes the wall-clock in the business timezone', () => {
    // 2026-09-14T12:00:00Z = 07:00 in America/Bogota (UTC-5, no DST).
    expect(aiTimeZone()).toBe('America/Bogota');
    expect(currentDateTimeContext()).toEqual({
      weekday: 'lunes',
      date: '2026-09-14',
      time: '07:00',
    });
  });

  it('defaults to America/Bogota when AI_TIMEZONE is unset', () => {
    delete process.env.AI_TIMEZONE;
    expect(aiTimeZone()).toBe('America/Bogota');
  });
});

describe('todayContextLine', () => {
  it('emits the fixed Spanish header with weekday, YYYY-MM-DD and 24h HH:MM', () => {
    expect(todayContextLine()).toBe(
      'INFORMACIÓN DE FECHA Y HORA ACTUAL: Hoy es lunes, 2026-09-14, hora local 07:00 (America/Bogota)'
    );
  });
});

describe('buildSystemPrompt', () => {
  it('prepends the today line as the opening instruction', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'draft' });

    const [first] = prompt.split('\n\n');
    expect(first).toBe(
      'INFORMACIÓN DE FECHA Y HORA ACTUAL: Hoy es lunes, 2026-09-14, hora local 07:00 (America/Bogota)'
    );
    expect(prompt).toContain('Eres Carlos Pavón, asesor comercial');
    expect(prompt).toContain('Humberto Manrique Arquitectura');
  });

  it('defines the natural 3-step conversation flow', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' });
    expect(prompt).toContain('FLUJO CONVERSACIONAL EN 3 PASOS');
    expect(prompt).toContain('PASO 1 — ENTENDER LA NECESIDAD');
    expect(prompt).toContain('PASO 2 — DIAGNÓSTICO Y VALOR');
    expect(prompt).toContain(
      'PASO 3 — INVITACIÓN A CITA VIRTUAL POR GOOGLE MEET'
    );
    expect(prompt).toContain('diseño arquitectónico, remodelación u otro servicio');
  });

  it('does not invite the customer to book before understanding the need', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' });
    expect(prompt).toContain('No pidas cita todavía');
    expect(prompt).toContain(
      'Solo después de entender la necesidad y haber aportado valor'
    );
  });

  it('offers a natural Google Meet invitation once the project is understood', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' });
    expect(prompt).toContain(
      '"Claro que sí. Para revisar tu proyecto a mayor profundidad y darte orientación experta, podemos agendar una cita virtual con el arquitecto"'
    );
  });

  it('opens with the inviolable rules and forces Spanish-only replies', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' });
    expect(prompt).toContain('REGLAS INVIOLABLES');
    expect(prompt).toContain('RESPONDE SIEMPRE');
    expect(prompt).toContain('PROHIBIDO INVENTAR');
    expect(prompt).toContain('SIN REPETICIONES');
    expect(prompt).toContain('responde SIEMPRE en español');
    expect(prompt).toContain(
      'está estrictamente prohibido responder en inglés'
    );
    // Max priority == it must come before the business context and tools.
    expect(prompt.indexOf('REGLAS INVIOLABLES')).toBeLessThan(
      prompt.indexOf('IDENTIDAD Y SERVICIOS DEL ESTUDIO')
    );
  });

  it('does not invent company data or links', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' });
    expect(prompt).toContain('no inventes precios, direcciones');
    expect(prompt).toContain('Solo comparte el enlace exacto');
    expect(prompt).not.toMatch(/calle \d|carrera \d|av\. \d/i);
  });

  it('forces memory and anti-repetition of greetings and questions', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' });
    expect(prompt).toContain('lee todo el historial antes de responder');
    expect(prompt).toContain('no repitas una pregunta ya respondida');
    expect(prompt).toContain('no repitas la invitación a agendar si ya la hiciste');
    expect(prompt).toContain('REGLAS ANTI-REPETICIÓN');
    expect(prompt).toContain('NO vuelvas a saludar');
    expect(prompt).toContain(
      'No propongas la cita virtual en el primer mensaje'
    );
  });

  it('never teaches an automatic handoff and demands a reply to every message', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' });
    // CERO handoff automático: el inline no instruye el sentinel y ninguna
    // conversación puede quedar en visto.
    expect(prompt).not.toContain('[[HANDOFF]]');
    expect(prompt).not.toContain('responde exactamente con');
    expect(prompt).toContain('ninguna conversación debe quedar en visto');
    expect(prompt).toContain('responder SIEMPRE en español a cada mensaje');
  });

  it('connects the real calendar and Google Meet tools', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      calendarEnabled: true,
    });
    expect(prompt).toContain('AGENDA Y GOOGLE MEET');
    expect(prompt).toContain('ver_disponibilidad');
    expect(prompt).toContain('agendar_cita');
    expect(prompt).toContain('reagendar_cita');
    expect(prompt).toContain('cancelar_cita');
    expect(prompt).toContain('enlace real de Google Meet');
    expect(prompt).toContain('Nunca ofrezcas un horario que no haya devuelto');
  });

  it('books directly once the customer gives a concrete date and time', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      calendarEnabled: true,
    });
    expect(prompt).toContain('CÓMO AGENDAR EN EL PASO 3');
    expect(prompt).toContain('No vuelvas a pedir la hora');
    expect(prompt).toContain('un correo faltante nunca bloquea la cita');
    expect(prompt).toContain('ISO de Bogotá');
  });

  it('explains how to proceed when Google Calendar fails', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      calendarEnabled: true,
    });
    expect(prompt).toContain(
      'Tu cita ha sido registrada. Te contactaremos pronto con los detalles'
    );
    expect(prompt).toContain('Nunca simules un enlace');
  });

  it('separates create, reschedule and cancel in one decision table', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      calendarEnabled: true,
    });
    expect(prompt).toContain(
      'CITA, REAGENDA Y CANCELACIÓN — ELIGE LA HERRAMIENTA CORRECTA'
    );
    expect(prompt).toContain('No tiene cita y quiere una nueva → agendar_cita');
    expect(prompt).toContain(
      'Ya tiene una cita confirmada y pide cambiarla de fecha u hora → reagendar_cita'
    );
    expect(prompt).toContain('Ya tiene cita y quiere cancelarla → cancelar_cita');
    expect(prompt).toContain('consultar_citas primero');
    expect(prompt).toContain('NUNCA agendar_cita: crearía una segunda cita');
  });

  it('makes the reschedule reply conditional on the tool result, never on prose', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      calendarEnabled: true,
    });
    expect(prompt).toContain('Si reagendar_cita devuelve confirmado:true');
    expect(prompt).toContain('nunca el anterior');
    expect(prompt).toContain('Si devuelve error, no confirmes nada');
    expect(prompt).toContain('sigue en su horario original');
  });

  it('forbids raw timestamps and invented links', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      calendarEnabled: true,
    });
    expect(prompt).toContain('HORAS, ENLACES Y FALLOS');
    expect(prompt).toContain('17:32:11 -05:00');
    expect(prompt).toContain('Nunca inventes disponibilidad, horas ni enlaces');
  });

  it('marks the injected idCita as optional and points at consultar_citas', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      calendarEnabled: true,
      citas: [
        {
          id: 'cita-7',
          fecha_inicio: '2026-09-22T09:00:00.000Z',
          estado: 'confirmada',
        },
      ],
    });
    expect(prompt).toContain('idCita="cita-7"');
    expect(prompt).toContain('el idCita es opcional');
    expect(prompt).toContain('llama consultar_citas');
  });

  it('appends business context without letting it override the safe flow', () => {
    const prompt = buildSystemPrompt({
      userPrompt: 'Somos un estudio boutique.',
      mode: 'auto_reply',
    });
    expect(prompt).toContain('Contexto del negocio e instrucciones adicionales');
    expect(prompt).toContain('Somos un estudio boutique.');
    expect(prompt).toContain('prevalecen las reglas de arriba');
  });

  it('appends knowledge extracts for grounding', () => {
    const prompt = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      knowledge: ['La valoración inicial no tiene costo.'],
    });
    expect(prompt).toContain('Base de conocimiento');
    expect(prompt).toContain('[1] La valoración inicial no tiene costo.');
  });
});
