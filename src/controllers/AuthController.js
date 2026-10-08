const connection = require('../database/connection');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');

require('dotenv/config');

module.exports = {

    // ==========================================================
    // CADASTRO
    // ==========================================================

    async signUp(request, response) {

        const trx = await connection.transaction();

        try {

            const {
                nome,
                email,
                telefone,
                password,
                tipo,
                cnh,
                veiculo
            } = request.body;

            // ======================================================
            // VALIDAÇÕES BÁSICAS
            // ======================================================

            if (!nome || !email || !telefone || !password) {

                await trx.rollback();

                return response.status(400).json({
                    error: 'Nome, email, telefone e senha são obrigatórios.'
                });
            }

            const tipoUsuario = tipo || 'CLIENTE';

            if (!['CLIENTE', 'MOTORISTA'].includes(tipoUsuario)) {

                await trx.rollback();

                return response.status(400).json({
                    error: 'Tipo de usuário inválido.'
                });
            }

            // ======================================================
            // VERIFICAR EMAIL
            // ======================================================

            const emailExistente = await trx('usuarios')
                .where('email', email)
                .first();

            if (emailExistente) {

                await trx.rollback();

                return response.status(400).json({
                    error: 'Já existe um usuário com este email.'
                });
            }

            // ======================================================
            // VERIFICAR TELEFONE
            // ======================================================

            const telefoneExistente = await trx('usuarios')
                .where('telefone', telefone)
                .first();

            if (telefoneExistente) {

                await trx.rollback();

                return response.status(400).json({
                    error: 'Já existe um usuário com este telefone.'
                });
            }

            // ======================================================
            // MOTORISTA
            // ======================================================

            if (tipoUsuario === 'MOTORISTA') {

                if (!cnh || !cnh.trim()) {

                    await trx.rollback();

                    return response.status(400).json({
                        error: 'A CNH é obrigatória para motoristas.'
                    });
                }

                if (!veiculo) {

                    await trx.rollback();

                    return response.status(400).json({
                        error: 'Os dados do veículo são obrigatórios para motoristas.'
                    });
                }

                const {
                    marca_id,
                    modelo_id,
                    categoria_id,
                    placa,
                    cor,
                    ano
                } = veiculo;

                // ==================================================
                // VALIDAR VEÍCULO
                // ==================================================

                if (
                    !marca_id ||
                    !modelo_id ||
                    !categoria_id ||
                    !placa
                ) {

                    await trx.rollback();

                    return response.status(400).json({
                        error: 'Marca, modelo, categoria e placa são obrigatórios.'
                    });
                }

                // ==================================================
                // VERIFICAR MARCA
                // ==================================================

                const marca = await trx('marcas')
                    .where('idMarca', marca_id)
                    .where('ativo', 1)
                    .first();

                if (!marca) {

                    await trx.rollback();

                    return response.status(400).json({
                        error: 'Marca do veículo inválida.'
                    });
                }

                // ==================================================
                // VERIFICAR MODELO
                //
                // Também garante que o modelo pertence à marca
                // selecionada.
                // ==================================================

                const modelo = await trx('modelos')
                    .where('idModelo', modelo_id)
                    .where('marca_id', marca_id)
                    .where('ativo', 1)
                    .first();

                if (!modelo) {

                    await trx.rollback();

                    return response.status(400).json({
                        error: 'Modelo do veículo inválido para a marca selecionada.'
                    });
                }

                // ==================================================
                // VERIFICAR CATEGORIA
                // ==================================================

                const categoria = await trx('categorias')
                    .where('id', categoria_id)
                    .where('ativo', 1)
                    .first();

                if (!categoria) {

                    await trx.rollback();

                    return response.status(400).json({
                        error: 'Categoria do veículo inválida.'
                    });
                }

                // ==================================================
                // VERIFICAR PLACA
                // ==================================================

                const placaFormatada = placa
                    .trim()
                    .toUpperCase()
                    .replace(/\s/g, '');

                const placaExistente = await trx('veiculos')
                    .where('placa', placaFormatada)
                    .first();

                if (placaExistente) {

                    await trx.rollback();

                    return response.status(400).json({
                        error: 'Já existe um veículo cadastrado com esta placa.'
                    });
                }

                // ==================================================
                // VALIDAR ANO
                // ==================================================

                let anoVeiculo = null;

                if (ano !== undefined && ano !== null && ano !== '') {

                    const anoNumerico = Number(ano);
                    const anoAtual = new Date().getFullYear();

                    if (
                        Number.isNaN(anoNumerico) ||
                        anoNumerico < 1950 ||
                        anoNumerico > anoAtual + 1
                    ) {

                        await trx.rollback();

                        return response.status(400).json({
                            error: 'Ano do veículo inválido.'
                        });
                    }

                    anoVeiculo = anoNumerico;
                }

                // ==================================================
                // CRIAR USUÁRIO
                // ==================================================

                const senhaHash = await bcrypt.hash(
                    password,
                    12
                );

                const usuarioId = randomUUID();

                await trx('usuarios').insert({
                    id: usuarioId,
                    nome: nome.trim(),
                    email: email.trim(),
                    telefone: telefone.trim(),
                    senha: senhaHash,
                    tipo: tipoUsuario,
                    status: 'ATIVO'
                });

                // ==================================================
                // CRIAR MOTORISTA
                // ==================================================

                const motoristaId = randomUUID();

                await trx('motoristas').insert({
                    id: motoristaId,
                    usuario_id: usuarioId,
                    cnh: cnh.trim(),
                    status: 'PENDENTE',
                    online: false
                });

                // ==================================================
                // CRIAR VEÍCULO
                //
                // A capacidade vem da categoria.
                // Não confiamos no aplicativo para esse valor.
                // ==================================================

                await trx('veiculos').insert({
                    id: randomUUID(),

                    motorista_id: motoristaId,

                    categoria_id: categoria_id,

                    marca_id: marca_id,

                    modelo_id: modelo_id,

                    placa: placaFormatada,

                    cor: cor
                        ? cor.trim()
                        : null,

                    ano: anoVeiculo,

                    capacidade:
                        categoria.capacidade_passageiros,

                    ativo: 1
                });

                // ==================================================
                // CONFIRMAR TRANSAÇÃO
                // ==================================================

                await trx.commit();

                return response.status(201).json({
                    message: 'Usuário, motorista e veículo cadastrados com sucesso.',
                    id: usuarioId
                });

            }

            // ======================================================
            // CLIENTE
            // ======================================================

            const senhaHash = await bcrypt.hash(
                password,
                12
            );

            const usuarioId = randomUUID();

            await trx('usuarios').insert({
                id: usuarioId,
                nome: nome.trim(),
                email: email.trim(),
                telefone: telefone.trim(),
                senha: senhaHash,
                tipo: tipoUsuario,
                status: 'ATIVO'
            });

            // ======================================================
            // CONFIRMAR TRANSAÇÃO
            // ======================================================

            await trx.commit();

            return response.status(201).json({
                message: 'Usuário cadastrado com sucesso.',
                id: usuarioId
            });

        } catch (error) {

            console.error(
                'Erro ao cadastrar usuário:',
                error
            );

            try {
                await trx.rollback();
            } catch (rollbackError) {
                console.error(
                    'Erro ao desfazer transação:',
                    rollbackError
                );
            }

            return response.status(500).json({
                error: 'Erro ao cadastrar usuário.'
            });
        }
    },

    // ==========================================================
    // LOGIN
    // ==========================================================

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

            // ==========================================================
            // BUSCAR DADOS DO MOTORISTA
            // ==========================================================

            let motorista = null;

            if (usuario.tipo === 'MOTORISTA') {

                motorista = await connection('motoristas')
                    .where(
                        'motoristas.usuario_id',
                        usuario.id
                    )
                    .select(
                        'motoristas.id',
                        'motoristas.cnh',
                        'motoristas.status',
                        'motoristas.online'
                    )
                    .first();

                if (motorista) {

                    // MySQL TINYINT(1) -> boolean
                    motorista.online = Boolean(
                        motorista.online
                    );

                    // ==================================================
                    // BUSCAR VEÍCULO DO MOTORISTA
                    // ==================================================

                    const veiculo = await connection('veiculos')

                        // Marca
                        .leftJoin(
                            'marcas',
                            'veiculos.marca_id',
                            'marcas.idMarca'
                        )

                        // Modelo
                        .leftJoin(
                            'modelos',
                            'veiculos.modelo_id',
                            'modelos.idModelo'
                        )

                        // Categoria
                        .leftJoin(
                            'categorias',
                            'veiculos.categoria_id',
                            'categorias.id'
                        )

                        .where(
                            'veiculos.motorista_id',
                            motorista.id
                        )

                        .where(
                            'veiculos.ativo',
                            1
                        )

                        .select(

                            // ------------------------------
                            // VEÍCULO
                            // ------------------------------

                            'veiculos.id',
                            'veiculos.placa',
                            'veiculos.cor',
                            'veiculos.ano',
                            'veiculos.capacidade',

                            // ------------------------------
                            // MARCA
                            // ------------------------------

                            'marcas.idMarca as marca_id',
                            'marcas.nome as marca',

                            // ------------------------------
                            // MODELO
                            // ------------------------------

                            'modelos.idModelo as modelo_id',
                            'modelos.nome as modelo',

                            // ------------------------------
                            // CATEGORIA
                            // ------------------------------

                            'categorias.id as categoria_id',
                            'categorias.nome as categoria'

                        )

                        .first();

                    motorista.veiculo = veiculo || null;
                }
            }

            // ==========================================================
            // TOKEN
            // ==========================================================

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

            // ==========================================================
            // RESPOSTA
            // ==========================================================

            return response.json({

                id: usuario.id,

                name: usuario.nome,

                email: usuario.email,

                telefone: usuario.telefone,

                tipo: usuario.tipo,

                // Para CLIENTE será null
                // Para MOTORISTA terá os dados completos
                motorista,

                token,

                refreshToken
            });

        } catch (error) {

            console.error(
                'Erro ao realizar login:',
                error
            );

            return response.status(500).json({
                error: 'Erro ao realizar login.'
            });
        }
    },
    
};