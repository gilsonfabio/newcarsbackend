const connection = require('../database/connection');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');

require('dotenv/config');

module.exports = {

    async signUp(request, response) {

        try {

            const {
                nome,
                email,
                telefone,
                password,
                tipo
            } = request.body;

            if (!nome || !email || !telefone || !password) {
                return response.status(400).json({
                    error: 'Nome, email, telefone e senha são obrigatórios.'
                });
            }

            const emailExistente = await connection('usuarios')
                .where('email', email)
                .first();

            if (emailExistente) {
                return response.status(400).json({
                    error: 'Já existe um usuário com este email.'
                });
            }

            const telefoneExistente = await connection('usuarios')
                .where('telefone', telefone)
                .first();

            if (telefoneExistente) {
                return response.status(400).json({
                    error: 'Já existe um usuário com este telefone.'
                });
            }

            const senhaHash = await bcrypt.hash(password, 12);

            const usuarioId = randomUUID();

            const tipoUsuario = tipo || 'CLIENTE';

            await connection('usuarios').insert({
                id: usuarioId,
                nome,
                email,
                telefone,
                senha: senhaHash,
                tipo: tipoUsuario,
                status: 'ATIVO'
            });

            /*
             * Se for motorista, já criamos
             * o registro correspondente.
             */
            if (tipoUsuario === 'MOTORISTA') {

                await connection('motoristas').insert({
                    id: randomUUID(),
                    usuario_id: usuarioId,
                    cnh: request.body.cnh,
                    status: 'PENDENTE',
                    online: false
                });

            }

            return response.status(201).json({
                message: 'Usuário cadastrado com sucesso.',
                id: usuarioId
            });

        } catch (error) {

            console.error(error);

            return response.status(500).json({
                error: 'Erro ao cadastrar usuário.'
            });
        }
    },

    async signIn(request, response) {

        try {

            const {
                email,
                password
            } = request.body;

            const usuario = await connection('usuarios')
                .where('email', email)
                .select(
                    'id',
                    'nome',
                    'email',
                    'telefone',
                    'senha',
                    'tipo',
                    'status'
                )
                .first();

            if (!usuario) {

                return response.status(400).json({
                    error: 'Não encontrou usuário com este email.'
                });

            }

            if (usuario.status !== 'ATIVO') {

                return response.status(403).json({
                    error: 'Usuário não está ativo.'
                });

            }

            const match = await bcrypt.compare(
                password,
                usuario.senha
            );

            if (!match) {

                return response.status(403).json({
                    auth: false,
                    message: 'Usuário ou senha inválidos!'
                });

            }

            const payload = {
                id: usuario.id,
                tipo: usuario.tipo
            };

            const token = jwt.sign(
                payload,
                process.env.SECRET_JWT,
                {
                    expiresIn: '1h'
                }
            );

            const refreshToken = jwt.sign(
                payload,
                process.env.SECRET_JWT_REFRESH,
                {
                    expiresIn: '7d'
                }
            );

            return response.json({

                id: usuario.id,

                name: usuario.nome,

                email: usuario.email,

                telefone: usuario.telefone,

                tipo: usuario.tipo,

                token,

                refreshToken

            });

        } catch (error) {

            console.error(error);

            return response.status(500).json({
                error: 'Erro ao realizar login.'
            });
        }
    }
};