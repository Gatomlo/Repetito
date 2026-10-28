// Envoi de mail pour la reinitialisation de mot de passe, via nodemailer (pur JavaScript,
// aucun module natif). Deux modes, choisis automatiquement :
//
// 1) "sendmail" (par defaut, sans aucune configuration) : passe par le programme sendmail
//    deja installe sur l'hebergement, exactement comme mail() en PHP — pas de boite mail
//    ni de mot de passe a creer. Necessite juste que ce programme soit present et
//    accessible depuis le processus Node (courant sur un hebergement mutualise, pas garanti
//    partout). MAIL_FROM (optionnelle) fixe l'adresse d'expedition ; sans elle, les mails
//    partent de "repetito@localhost", que beaucoup de destinataires classeront en spam —
//    mets une adresse de ton propre domaine si tu peux.
//
// 2) "smtp" (si SMTP_HOST est defini) : se connecte a une vraie boite mail externe.
//    Variables : SMTP_HOST, SMTP_PORT (587 par defaut), SMTP_SECURE (1 pour du TLS direct,
//    port 465), SMTP_USER, SMTP_PASS, MAIL_FROM (sinon SMTP_USER).
//
// Aucun identifiant n'est jamais dans le code : tout se regle par variables d'environnement
// sur le serveur (voir README.md).
const SENDMAIL_PATHS = ['sendmail', '/usr/sbin/sendmail', '/usr/lib/sendmail', '/usr/bin/sendmail'];

function transportMode() {
  return process.env.SMTP_HOST ? 'smtp' : 'sendmail';
}
function isConfigured() {
  if (transportMode() === 'smtp') return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  return true; // mode sendmail : toujours tente, un echec (programme absent) est signale a l'envoi
}
function fromAddress() {
  return process.env.MAIL_FROM || process.env.SMTP_USER || 'repetito@localhost';
}
function mailPayload(to, name, code) {
  return {
    from: `Répétito <${fromAddress()}>`,
    to,
    subject: 'Répétito — Réinitialisation de ton mot de passe',
    text: `Bonjour ${name},\n\nVoici ton code de réinitialisation : ${code}\n\nIl est valable 30 minutes. Saisis-le dans l'application pour choisir un nouveau mot de passe.\n\nSi tu n'as pas demandé ce code, ignore ce message.`,
    html: `<p>Bonjour ${name},</p><p>Voici ton code de réinitialisation :</p><p style="font-size:24px;font-weight:700;letter-spacing:3px">${code}</p><p>Il est valable 30 minutes. Saisis-le dans l'application pour choisir un nouveau mot de passe.</p><p style="color:#888;font-size:13px">Si tu n'as pas demandé ce code, ignore ce message.</p>`,
  };
}

let smtpTransporter = null;
function getSmtpTransporter() {
  if (!smtpTransporter) {
    const nodemailer = require('nodemailer');
    smtpTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT, 10) || 587,
      secure: process.env.SMTP_SECURE === '1',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return smtpTransporter;
}

// Essaie chaque emplacement courant de "sendmail" a tour de role (SENDMAIL_PATH force un
// seul chemin si defini) : un hebergement mutualise ne l'installe pas toujours au meme endroit.
async function sendViaSendmail(payload) {
  const nodemailer = require('nodemailer');
  const candidates = process.env.SENDMAIL_PATH ? [process.env.SENDMAIL_PATH] : SENDMAIL_PATHS;
  let lastErr;
  for (const path of candidates) {
    try {
      const transporter = nodemailer.createTransport({ sendmail: true, newline: 'unix', path });
      await transporter.sendMail(payload);
      return;
    } catch (e) { lastErr = e; }
  }
  throw new Error("Programme sendmail introuvable sur ce serveur (essayé : " + candidates.join(', ') + ") — " + (lastErr && lastErr.message));
}

async function sendResetCode(to, name, code) {
  if (!isConfigured()) throw new Error("Envoi de mail non configure sur le serveur (variables SMTP_* manquantes) — demande a l'administrateur de reinitialiser ton mot de passe.");
  const payload = mailPayload(to, name, code);
  if (transportMode() === 'smtp') await getSmtpTransporter().sendMail(payload);
  else await sendViaSendmail(payload);
}

module.exports = { isConfigured, sendResetCode };
