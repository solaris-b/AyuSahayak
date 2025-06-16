import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

// Resolve __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY in .env");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Set up Express server
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware setup
app.use(cors({ origin: "*", methods: "*", allowedHeaders: "*" }));
app.use(express.json());

// static frontend files
app.use('/ui', express.static(path.join(__dirname, '..', 'public')));

interface Patient {
    id: string;
    age: number;
    diagnosis: string;
    history: string[];
}

interface PrescriptionRequest {
    patient_id: string;
    symptoms: string;
    final_prescription?: string;
}

// Load patients data into memory
let patients: Patient[] = [];

const loadPatients = async () => {
    try {
        const patientsData = await fs.readFile(path.join(__dirname, '..', 'app', 'data', 'patients.json'), 'utf-8');
        patients = JSON.parse(patientsData);
    } catch (error) {
        console.error('Error loading patients data:', error);
        patients = [];
    }
};

loadPatients();

// API: Get all patients
app.get('/api/patients', (req, res) => {
    res.json(patients);
});

// API: Get patient by ID
app.get('/api/patients/:patient_id', (req, res) => {
    const { patient_id } = req.params;
    const patient = patients.find(p => p.id === patient_id);
    if (!patient) {
        return res.status(404).json({ detail: "Patient not found" });
    }
    res.json(patient);
});

// API: Generate prescription using Gemini
app.post('/api/generate_prescription', async (req, res) => {
    try {
        const { patient_id, symptoms, final_prescription }: PrescriptionRequest = req.body;

        // Validate input
        if (!symptoms || !patient_id) {
            return res.status(400).json({ detail: "Symptoms and patient required" });
        }

        const patient = patients.find(p => p.id === patient_id);
        if (!patient) {
            return res.status(404).json({ detail: "Invalid patient ID" });
        }

        // Read past prescription data for memory
        let history = "";
        try {
            history = await fs.readFile('past_prescriptions.txt', 'utf-8');
        } catch {
            history = "";
        }

        
        const prompt = `
You are a licensed doctor. Based on the following patient details and symptoms, write a professional, short, and safe prescription using only generic medicine names.

Patient Details:
- Age: ${patient.age}
- Diagnosis: ${patient.diagnosis}
- History: ${patient.history.join(', ')}

Current Symptoms: ${symptoms}

${history ? `Past data:\n${history}` : ""}

Start the prescription directly. Do not include disclaimers or introductions.
`;

        // Generate prescription
        const response = await ai.models.generateContent({
            model: "gemini-1.5-flash",
            contents: prompt,
        });

        const generated = response.text?.trim() || "";
        const finalPrescription = final_prescription || generated;

        // Append to memory file
        const logEntry = `\nPatient: ${patient_id} | Symptoms: ${symptoms} | Prescription: ${finalPrescription}\n`;
        await fs.appendFile('past_prescriptions.txt', logEntry, 'utf-8');

        res.json({ generated, prescription: finalPrescription });

    } catch (error: any) {
        console.error('Error generating prescription:', error);

        if (error.message?.includes('API')) {
            return res.status(500).json({ detail: "Gemini API failed: " + error.message });
        }

        res.status(500).json({ detail: "Unexpected error: " + error.message });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`UI available at http://localhost:${PORT}/ui`);
});

export default app;
