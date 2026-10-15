const nodemailer = require('nodemailer');

require('dotenv/config');

async function enviarEmailRecuperacao(email, nome, token) {
    const {
        SMTP_HOST,
        SMTP_PORT,
        SMTP_SECURE,
        SMTP_USER,
        SMTP_PASS,
        SMTP_FROM,
        APP_RESET_PASSWORD_URL
    } = process.env;

    if (
        !SMTP_HOST ||
        !SMTP_PORT ||
        !SMTP_USER ||
        !SMTP_PASS ||
        !SMTP_FROM ||
        !APP_RESET_PASSWORD_URL
    ) {
        throw new Error(
            'Configuração SMTP ou URL de recuperação ausente.'
        );
    }

    const transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: Number(SMTP_PORT),
        secure: SMTP_SECURE === 'true',
        auth: {
            user: SMTP_USER,
            pass: SMTP_PASS
        }
    });

    const separador = APP_RESET_PASSWORD_URL.includes('?')
        ? '&'
        : '?';

    const link = `${APP_RESET_PASSWORD_URL}${separador}token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;

    await transporter.sendMail({
        from: SMTP_FROM,
        to: email,
        subject: 'Recuperação de senha - NowCar',
        text: [
            `Olá, ${nome}!`,
            '',
            'Recebemos uma solicitação para redefinir a senha da sua conta NowCar.',
            '',
            'Acesse o link abaixo para continuar:',
            link,
            '',
            'Este link expira em 30 minutos e pode ser utilizado apenas uma vez.',
            'Se você não solicitou a recuperação, ignore este e-mail.'
        ].join('\n'),
        html: `
            <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#222">
                <h2>Recuperação de senha</h2>
                <p>Olá, ${String(nome).replace(/[&<>"']/g, caracter => ({
                    '&': '&amp;',
                    '<': '&lt;',
                    '>': '&gt;',
                    '"': '&quot;',
                    "'": '&#39;'
                })[caracter])}!</p>
                <p>Recebemos uma solicitação para redefinir a senha da sua conta NowCar.</p>
                <p style="margin:28px 0">
                    <a href="${link}"
                       style="background:#111;color:#fff;padding:14px 22px;text-decoration:none;border-radius:8px;display:inline-block">
                        Redefinir minha senha
                    </a>
                </p>
                <p>Este link expira em 30 minutos e só pode ser usado uma vez.</p>
                <p>Se você não solicitou a recuperação, ignore este e-mail.</p>
            </div>
        `
    });
}

module.exports = {
    enviarEmailRecuperacao
};
