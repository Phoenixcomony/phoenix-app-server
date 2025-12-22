// server/imdad/config.js
import dotenv from 'dotenv';
dotenv.config({ override: true });

export const IMDAD_BASE_URL = process.env.IMDAD_BASE_URL;
export const IMDAD_LOGIN_PATH = process.env.IMDAD_LOGIN_PATH;
export const IMDAD_APPTS_PATH = process.env.IMDAD_APPTS_PATH;
export const IMDAD_USERNAME = process.env.IMDAD_USERNAME;
export const IMDAD_PASSWORD = process.env.IMDAD_PASSWORD;

export const IMDAD_REFRESH_SECONDS = Number(process.env.IMDAD_REFRESH_SECONDS || 10);
export const defaultClinicId = 'phoenix-main';
export const defaultMonth = new Date().toISOString().slice(0, 7);
