#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) throw new Error('Missing GEMINI_API_KEY in .env');

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Patient {
  id: string;
  name: string;
  age: number;
  diagnosis: string;
  history: string[];
}

interface PrescriptionRequest {
  patient_id: string;
  symptoms: string;
  final_prescription?: string;
}

let patients: Patient[] = [];

const loadPatients = async (): Promise<void> => {
  try {
    const data = await fs.readFile(
      path.join(__dirname, '..', 'app', 'data', 'patients.json'),
      'utf-8'
    );
    patients = JSON.parse(data);
    console.log("Loaded patients:", patients.map(p => p.name));
  } catch (err) {
    console.error("Failed to load patients.json", err);
    patients = [];
  }
};

await loadPatients();

const generatePrompt = (patient: Patient, symptoms: string, history: string): string => `
You are a licensed doctor. Based on the following patient details and symptoms, write a professional, short, and safe prescription using only generic medicine names.

Patient Details:
- Age: ${patient.age}
- Diagnosis: ${patient.diagnosis}
- History: ${patient.history.join(', ')}

Current Symptoms: ${symptoms}

${history ? `Past data:\n${history}` : ''}

Start the prescription directly. Do not include disclaimers or introductions.
`;

const generatePrescription = async (
  req: PrescriptionRequest
): Promise<{ generated: string; prescription: string; patient: Patient }> => {
  const patient = patients.find((p) => p.id === req.patient_id);
  if (!patient) throw new Error('Invalid patient ID');

  let history = '';
  try {
    history = await fs.readFile('past_prescriptions.txt', 'utf-8');
  } catch {}

  const prompt = generatePrompt(patient, req.symptoms, history);

  const response = await ai.models.generateContent({
    model: 'gemini-1.5-flash',
    contents: prompt,
  });

  const generated = response.text?.trim() || '';
  const finalOutput = req.final_prescription || generated;

  await fs.appendFile(
    'past_prescriptions.txt',
    `\nPatient: ${req.patient_id} | Symptoms: ${req.symptoms} | Prescription: ${finalOutput}\n`,
    'utf-8'
  );

  return { generated, prescription: finalOutput, patient };
};

// MCP server for programmatic tool access via LLM agents
const mcp = new MCPServer({ name: 'prescription-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_all_patients',
      description: 'Get all patients',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_patient_by_id',
      description: 'Fetch one patient',
      inputSchema: {
        type: 'object',
        properties: {
          patient_id: { type: 'string', description: 'Patient ID' },
        },
        required: ['patient_id'],
      },
    },
    {
      name: 'generate_prescription',
      description: 'Generate prescription from symptoms',
      inputSchema: {
        type: 'object',
        properties: {
          patient_id: { type: 'string' },
          symptoms: { type: 'string' },
          final_prescription: { type: 'string' },
        },
        required: ['patient_id', 'symptoms'],
      },
    },
    {
      name: 'get_prescription_history',
      description: 'Get prescription log',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments as Partial<PrescriptionRequest> | undefined;
  if (!args) return { content: [{ type: 'text', text: 'Missing arguments' }] };

  try {
    switch (request.params.name) {
      case 'get_all_patients':
        return {
          content: [{ type: 'text', text: JSON.stringify(patients, null, 2) }],
        };
      case 'get_patient_by_id': {
        if (!args.patient_id) throw new Error('patient_id is required');
        const patient = patients.find((p) => p.id === args.patient_id);
        if (!patient) throw new Error('Not found');
        return { content: [{ type: 'text', text: JSON.stringify(patient, null, 2) }] };
      }
      case 'generate_prescription': {
        const result = await generatePrescription(args as PrescriptionRequest);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'get_prescription_history': {
        const history = await fs.readFile('past_prescriptions.txt', 'utf-8').catch(() => '');
        return { content: [{ type: 'text', text: history || 'No history found.' }] };
      }
      default:
        throw new Error('Unknown tool');
    }
  } catch (e: unknown) {
    const err = e as Error;
    return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
  }
});

mcp.onerror = (err) => console.error('[MCP Error]', err);
mcp.connect(new StdioServerTransport()).then(() => {
  console.log('[MCP] Running on stdio');
});

const app = express();
app.use(cors());
app.use(express.json());
app.use('/ui', express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

app.get('/api/patients', (req, res) => res.json(patients));

app.get('/api/patients/:patient_id', (req, res) => {
  const patient = patients.find((p) => p.id === req.params.patient_id);
  if (!patient) return res.status(404).json({ detail: 'Patient not found' });
  res.json(patient);
});

app.get('/api/history', async (req, res) => {
  const history = await fs.readFile('past_prescriptions.txt', 'utf-8').catch(() => '');
  res.send(history || 'No history');
});

app.post('/api/generate_prescription', async (req, res) => {
  const { patient_id, symptoms, final_prescription } = req.body as PrescriptionRequest;
  try {
    const result = await generatePrescription({ patient_id, symptoms, final_prescription });
    res.json(result);
  } catch (e: unknown) {
    const err = e as Error;
    res.status(500).json({ detail: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Express] UI on http://localhost:${PORT}/ui`);
});
