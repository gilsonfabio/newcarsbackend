const connection = require('../database/connection');
const bcrypt = require('bcrypt');
const {
    randomUUID,
    randomBytes,
    createHash
} = require('crypto');

const {
    enviarEmailRecuperacao
} = require('../services/EmailService');

require('dotenv/config');

const TEMPO_EXPIRACAO_MINUTOS = 30;

function gerarHashToken(token) {
    return createHash('sha256')
        .update(token)
        .digest('hex');
}

module.exports = {
    // ==========================================================
    // SOLICITAR RECUPERAÇÃO
    // POST /password/forgot
    // ==========================================================

    async forgot(request, response) {
        try {
            const email = String(
                request.body?.email || ''
            ).trim().toLowerCase();

            if (
                !email ||
                email.length > 150 ||
                !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
            ) {
                return response.status(400).json({
                    error: 'Informe um e-mail válido.'
                });
            }

            const usuario = await connection('usuarios')
                .whereRaw('LOWER(email) = ?', [email])
                .select('id', 'nome', 'email', 'status')
                .first();

            // Resposta genérica para não revelar se a conta existe.
            const mensagem = {
                message:
                    'Se existir uma conta associada a esse e-mail, você receberá as instruções de recuperação.'
            };

            if (!usuario || usuario.status !== 'ATIVO') {
                return response.status(200).json(mensagem);
            }

            const token = randomBytes(32).toString('hex');
            const tokenHash = gerarHashToken(token);

            const agora = new Date();
            const expiracao = new Date(
                agora.getTime() +
                TEMPO_EXPIRACAO_MINUTOS * 60 * 1000
            );

            // Invalida solicitações anteriores ainda não utilizadas.
            await connection('password_resets')
                .where('usuario_id', usuario.id)
                .whereNull('used_at')
                .update({
                    used_at: agora
                });

            await connection('password_resets').insert({
                id: randomUUID(),
                usuario_id: usuario.id,
                token_hash: tokenHash,
                expires_at: expiracao,
                used_at: null
            });

            try {
                await enviarEmailRecuperacao(
                    usuario.email,
                    usuario.nome,
                    token
                );
            } catch (emailError) {
                // Invalida o token se não for possível enviar o e-mail.
                await connection('password_resets')
                    .where('token_hash', tokenHash)
                    .whereNull('used_at')
                    .update({
                        used_at: new Date()
                    });

                throw emailError;
            }

            return response.status(200).json(mensagem);
        } catch (error) {
            console.error(
                'Erro ao solicitar recuperação de senha:',
                error
            );

            return response.status(500).json({
                error:
                    'Não foi possível processar a solicitação. Tente novamente.'
            });
        }
    },

    // ==========================================================
    // REDEFINIR SENHA
    // POST /password/reset
    // ==========================================================

    async reset(request, response) {
        const email = String(
            request.body?.email || ''
        ).trim().toLowerCase();

        const token = String(
            request.body?.token || ''
        );

        const password = request.body?.password;

        if (
            !email ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
            !/^[a-f0-9]{64}$/i.test(token) ||
            typeof password !== 'string' ||
            password.length < 8 ||
            Buffer.byteLength(password, 'utf8') > 72
        ) {
            return response.status(400).json({
                error:
                    'Informe um e-mail válido, um token válido e uma senha entre 8 e 72 bytes.'
            });
        }

        const tokenHash = gerarHashToken(token);
        const senhaHash = await bcrypt.hash(password, 12);

        const trx = await connection.transaction();

        try {
            const usuario = await trx('usuarios')
                .whereRaw('LOWER(email) = ?', [email])
                .select('id', 'status')
                .first();

            if (!usuario || usuario.status !== 'ATIVO') {
                await trx.rollback();

                return response.status(400).json({
                    error:
                        'Token inválido ou expirado. Solicite uma nova recuperação.'
                });
            }

            // Bloqueia a linha durante a validação para impedir
            // que duas solicitações utilizem o mesmo token.
            const recuperacao = await trx('password_resets')
                .where('usuario_id', usuario.id)
                .where('token_hash', tokenHash)
                .whereNull('used_at')
                .where('expires_at', '>', trx.fn.now())
                .forUpdate()
                .first();

            if (!recuperacao) {
                await trx.rollback();

                return response.status(400).json({
                    error:
                        'Token inválido ou expirado. Solicite uma nova recuperação.'
                });
            }

            const atualizado = await trx('password_resets')
                .where('id', recuperacao.id)
                .whereNull('used_at')
                .update({
                    used_at: trx.fn.now()
                });

            if (!atualizado) {
                await trx.rollback();

                return response.status(400).json({
                    error:
                        'Este link já foi utilizado. Solicite uma nova recuperação.'
                });
            }

            await trx('usuarios')
                .where('id', usuario.id)
                .update({
                    senha: senhaHash,
                    updated_at: trx.fn.now()
                });

            // Invalida também eventuais outros tokens pendentes.
            await trx('password_resets')
                .where('usuario_id', usuario.id)
                .whereNull('used_at')
                .update({
                    used_at: trx.fn.now()
                });

            await trx.commit();

            return response.status(200).json({
                message:
                    'Senha redefinida com sucesso. Entre com sua nova senha.'
            });
        } catch (error) {
            await trx.rollback();

            console.error(
                'Erro ao redefinir senha:',
                error
            );

            return response.status(500).json({
                error:
                    'Não foi possível redefinir a senha. Tente novamente.'
            });
        }
    }
};