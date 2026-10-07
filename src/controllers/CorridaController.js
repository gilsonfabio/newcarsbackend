const connection = require('../database/connection');
const { randomUUID } = require('crypto');

module.exports = {

    // ==========================================================
    // SOLICITAR CORRIDA - CLIENTE
    // ==========================================================

    async store(request, response) {

        try {

            const {
                origem,
                destino
            } = request.body;

            const clienteId = request.user.id;

            // ==========================================
            // VALIDAÇÃO DA ORIGEM
            // ==========================================

            if (!origem) {

                return response.status(400).json({
                    error: 'Localização de origem é obrigatória.'
                });

            }

            if (
                origem.latitude === undefined ||
                origem.latitude === null ||
                origem.longitude === undefined ||
                origem.longitude === null
            ) {

                return response.status(400).json({
                    error: 'Latitude e longitude da origem são obrigatórias.'
                });

            }

            const origemLatitude = Number(origem.latitude);
            const origemLongitude = Number(origem.longitude);

            if (
                !Number.isFinite(origemLatitude) ||
                !Number.isFinite(origemLongitude)
            ) {

                return response.status(400).json({
                    error: 'Latitude e longitude da origem são inválidas.'
                });

            }

            // ==========================================
            // VALIDAÇÃO DO DESTINO
            // ==========================================

            if (!destino) {

                return response.status(400).json({
                    error: 'Destino é obrigatório.'
                });

            }

            if (
                !destino.endereco ||
                typeof destino.endereco !== 'string' ||
                !destino.endereco.trim()
            ) {

                return response.status(400).json({
                    error: 'Endereço do destino é obrigatório.'
                });

            }

            if (
                destino.latitude === undefined ||
                destino.latitude === null ||
                destino.longitude === undefined ||
                destino.longitude === null
            ) {

                return response.status(400).json({
                    error: 'Latitude e longitude do destino são obrigatórias.'
                });

            }

            const destinoLatitude = Number(destino.latitude);
            const destinoLongitude = Number(destino.longitude);

            if (
                !Number.isFinite(destinoLatitude) ||
                !Number.isFinite(destinoLongitude)
            ) {

                return response.status(400).json({
                    error: 'Latitude e longitude do destino são inválidas.'
                });

            }

            // ==========================================
            // CONFIRMA CLIENTE
            // ==========================================

            const cliente = await connection('usuarios')
                .where('id', clienteId)
                .where('tipo', 'CLIENTE')
                .where('status', 'ATIVO')
                .first();

            if (!cliente) {

                return response.status(403).json({
                    error: 'Usuário não autorizado a solicitar corridas.'
                });

            }

            // ==========================================
            // CRIA CORRIDA
            // ==========================================

            const corridaId = randomUUID();

            await connection('corridas').insert({

                id: corridaId,

                cliente_id: clienteId,

                origem_latitude: origemLatitude,
                origem_longitude: origemLongitude,

                destino: destino.endereco.trim(),
                destino_latitude: destinoLatitude,
                destino_longitude: destinoLongitude,

                motorista_id: null,

                status: 'SOLICITADA',

                valor: null

            });

            // ==========================================
            // BUSCA CORRIDA CRIADA
            // ==========================================

            const corrida = await connection('corridas')
                .where('id', corridaId)
                .first();

            return response.status(201).json({
                message: 'Corrida solicitada com sucesso.',
                corrida
            });

        } catch (error) {

            console.error('Erro ao solicitar corrida:', error);

            return response.status(500).json({
                error: 'Erro ao solicitar corrida.'
            });

        }

    },

    // ==========================================================
    // CORRIDAS DISPONÍVEIS PARA MOTORISTAS
    // ==========================================================

    async disponiveis(request, response) {
        try {
            const usuarioId = request.user.id;

            // ==========================================
            // BUSCA O MOTORISTA
            // ==========================================

            const motorista = await connection('motoristas')
                .join(
                    'usuarios',
                    'usuarios.id',
                    'motoristas.usuario_id'
                )
                .where(
                    'motoristas.usuario_id',
                    usuarioId
                )
                .where(
                    'usuarios.tipo',
                    'MOTORISTA'
                )
                .where(
                    'usuarios.status',
                    'ATIVO'
                )
                .where(
                    'motoristas.status',
                    'APROVADO'
                )
                .select(
                    'motoristas.id',
                    'motoristas.usuario_id',
                    'motoristas.status',
                    'motoristas.online',
                    'motoristas.latitude',
                    'motoristas.longitude'
                )
                .first();

            if (!motorista) {
                return response.status(403).json({
                    error:
                        'Cadastro de motorista não encontrado, não aprovado ou usuário não autorizado.'
                });
            }

            // ==========================================
            // MOTORISTA PRECISA ESTAR ONLINE
            // ==========================================

            if (!motorista.online) {
                return response.status(403).json({
                    error:
                        'O motorista precisa estar online para visualizar corridas disponíveis.'
                });
            }

            // ==========================================
            // BUSCA CORRIDAS
            // ==========================================

            const corridas = await connection('corridas')
                .where(
                    'status',
                    'SOLICITADA'
                )
                .orderBy(
                    'created_at',
                    'desc'
                );

            return response.json({
                corridas
            });

        } catch (error) {

            console.error(
                'Erro ao buscar corridas disponíveis:',
                error
            );

            return response.status(500).json({
                error:
                    'Erro ao buscar corridas disponíveis.'
            });
        }
    },

    // ==========================================================
    // MOTORISTA ACEITA CORRIDA
    // ==========================================================

    async aceitar(request, response) {
        try {
            const usuarioId = request.user.id;
            const { id } = request.params;

            // ==========================================
            // CONFIRMA MOTORISTA
            // ==========================================

            const motorista = await connection('motoristas')
                .join(
                    'usuarios',
                    'usuarios.id',
                    'motoristas.usuario_id'
                )
                .where(
                    'motoristas.usuario_id',
                    usuarioId
                )
                .where(
                    'usuarios.tipo',
                    'MOTORISTA'
                )
                .where(
                    'usuarios.status',
                    'ATIVO'
                )
                .select(
                    'motoristas.id',
                    'motoristas.usuario_id',
                    'motoristas.status',
                    'motoristas.online'
                )
                .first();

            if (!motorista) {
                return response.status(403).json({
                    error:
                        'Cadastro de motorista não encontrado ou usuário não autorizado.'
                });
            }

            // ==========================================
            // MOTORISTA PRECISA ESTAR APROVADO
            // ==========================================

            if (motorista.status !== 'APROVADO') {
                return response.status(403).json({
                    error:
                        'O motorista ainda não está aprovado.'
                });
            }

            // ==========================================
            // MOTORISTA PRECISA ESTAR ONLINE
            // ==========================================

            if (!motorista.online) {
                return response.status(403).json({
                    error:
                        'O motorista precisa estar online para aceitar uma corrida.'
                });
            }

            // ==========================================
            // VERIFICA SE JÁ POSSUI CORRIDA ATIVA
            // ==========================================

            const corridaAtiva = await connection('corridas')
                .where(
                    'motorista_id',
                    motorista.id
                )
                .whereIn(
                    'status',
                    [
                        'ACEITA',
                        'EM_ANDAMENTO'
                    ]
                )
                .orderBy(
                    'created_at',
                    'desc'
                )
                .first();

            if (corridaAtiva) {
                return response.status(409).json({
                    error:
                        'O motorista já possui uma corrida aceita ou em andamento.',
                    corrida: corridaAtiva
                });
            }

            // ==========================================
            // INICIA TRANSAÇÃO
            // ==========================================

            const corrida = await connection.transaction(
                async (trx) => {

                    /*
                    * Só atualizamos se a corrida ainda estiver
                    * SOLICITADA.
                    *
                    * Isso evita que dois motoristas aceitem
                    * a mesma corrida.
                    */

                    const quantidade = await trx('corridas')
                        .where(
                            'id',
                            id
                        )
                        .where(
                            'status',
                            'SOLICITADA'
                        )
                        .update({
                            motorista_id: motorista.id,
                            status: 'ACEITA'
                        });

                    if (quantidade === 0) {
                        return null;
                    }

                    return await trx('corridas')
                        .where(
                            'id',
                            id
                        )
                        .first();
                }
            );

            // ==========================================
            // CORRIDA JÁ FOI ACEITA
            // ==========================================

            if (!corrida) {
                return response.status(409).json({
                    error:
                        'Esta corrida não está mais disponível.'
                });
            }

            // ==========================================
            // RESPOSTA
            // ==========================================

            return response.json({
                message:
                    'Corrida aceita com sucesso.',
                corrida
            });

        } catch (error) {

            console.error(
                'Erro ao aceitar corrida:',
                error
            );

            return response.status(500).json({
                error:
                    'Erro ao aceitar corrida.'
            });
        }
    },

    // ==========================================================
    // MOTORISTA INICIA CORRIDA
    // ==========================================================

    async iniciar(request, response) {

        try {

            const usuarioId = request.user.id;
            const { id } = request.params;

            // ==========================================
            // BUSCA O MOTORISTA
            // ==========================================

            const motorista = await connection('motoristas')
                .join(
                    'usuarios',
                    'usuarios.id',
                    'motoristas.usuario_id'
                )
                .where(
                    'motoristas.usuario_id',
                    usuarioId
                )
                .where(
                    'usuarios.tipo',
                    'MOTORISTA'
                )
                .where(
                    'usuarios.status',
                    'ATIVO'
                )
                .select(
                    'motoristas.id'
                )
                .first();

            if (!motorista) {

                return response.status(403).json({
                    error:
                        'Cadastro de motorista não encontrado ou usuário não autorizado.'
                });
            }

            // ==========================================
            // ATUALIZA A CORRIDA
            // ==========================================

            const quantidade =
                await connection('corridas')
                    .where('id', id)
                    .where(
                        'motorista_id',
                        motorista.id
                    )
                    .where(
                        'status',
                        'ACEITA'
                    )
                    .update({
                        status: 'EM_ANDAMENTO'
                    });

            if (quantidade === 0) {

                return response.status(409).json({
                    error:
                        'A corrida não está disponível para ser iniciada.'
                });
            }

            // ==========================================
            // BUSCA A CORRIDA ATUALIZADA
            // ==========================================

            const corrida =
                await connection('corridas')
                    .where('id', id)
                    .first();

            return response.json({
                message: 'Corrida iniciada com sucesso.',
                corrida
            });

        } catch (error) {

            console.error(
                'Erro ao iniciar corrida:',
                error
            );

            return response.status(500).json({
                error: 'Erro ao iniciar corrida.'
            });
        }
    },

    // ==========================================================
    // MOTORISTA FINALIZA CORRIDA
    // ==========================================================

    async finalizar(request, response) {
        try {
            const usuarioId = request.user.id;
            const { id } = request.params;

            // ==========================================
            // CONFIRMA MOTORISTA
            // ==========================================

            const motorista = await connection('motoristas')
                .join(
                    'usuarios',
                    'usuarios.id',
                    'motoristas.usuario_id'
                )
                .where('motoristas.usuario_id', usuarioId)
                .where('usuarios.tipo', 'MOTORISTA')
                .where('usuarios.status', 'ATIVO')
                .select(
                    'motoristas.id'
                )
                .first();

            if (!motorista) {

                return response.status(403).json({
                    error: 'Cadastro de motorista não encontrado ou usuário não autorizado.'
                });

            }

            // ==========================================
            // INICIA TRANSAÇÃO
            // ==========================================

            const corrida = await connection.transaction(
                async (trx) => {

                    /*
                    * Só permite finalizar uma corrida que:
                    *
                    * 1. Pertence ao motorista logado
                    * 2. Está EM_ANDAMENTO
                    */

                    const quantidade = await trx('corridas')
                        .where('id', id)
                        .where('motorista_id', motorista.id)
                        .where('status', 'EM_ANDAMENTO')
                        .update({
                            status: 'FINALIZADA'
                        });

                    if (quantidade === 0) {

                        return null;

                    }

                    return await trx('corridas')
                        .where('id', id)
                        .first();

                }
            );

            // ==========================================
            // CORRIDA NÃO PODE SER FINALIZADA
            // ==========================================

            if (!corrida) {

                return response.status(409).json({
                    error: 'Esta corrida não pode ser finalizada. Verifique se ela pertence a você e está em andamento.'
                });

            }

            // ==========================================
            // RESPOSTA
            // ==========================================

            return response.json({
                message: 'Corrida finalizada com sucesso.',
                corrida
            });

        } catch (error) {

            console.error(
                'Erro ao finalizar corrida:',
                error
            );

            return response.status(500).json({
                error: 'Erro ao finalizar corrida.'
            });

        }

    },

    // ==========================================================
    // MINHA CORRIDA ATUAL
    // CLIENTE OU MOTORISTA
    // ==========================================================

    async minha(request, response) {

        try {

            const usuarioId = request.user.id;

            // ==========================================
            // BUSCA USUÁRIO
            // ==========================================

            const usuario = await connection('usuarios')
                .where('id', usuarioId)
                .where('status', 'ATIVO')
                .first();

            if (!usuario) {

                return response.status(403).json({
                    error: 'Usuário não autorizado.'
                });

            }

            // ==================================================
            // MOTORISTA
            // ==================================================

            if (usuario.tipo === 'MOTORISTA') {

                const motorista = await connection('motoristas')
                    .where(
                        'usuario_id',
                        usuarioId
                    )
                    .first();

                if (!motorista) {

                    return response.status(403).json({
                        error:
                            'Cadastro de motorista não encontrado.'
                    });

                }

                const corrida = await connection('corridas')
                    .where(
                        'motorista_id',
                        motorista.id
                    )
                    .whereIn(
                        'status',
                        [
                            'ACEITA',
                            'EM_ANDAMENTO'
                        ]
                    )
                    .orderBy(
                        'created_at',
                        'desc'
                    )
                    .first();

                return response.json({
                    corrida: corrida || null
                });
            }

            // ==================================================
            // CLIENTE
            // ==================================================

            if (usuario.tipo === 'CLIENTE') {

                const corrida = await connection('corridas')
                    .where(
                        'corridas.cliente_id',
                        usuarioId
                    )
                    .whereIn(
                        'corridas.status',
                        [
                            'SOLICITADA',
                            'ACEITA',
                            'EM_ANDAMENTO'
                        ]
                    )
                    .leftJoin(
                        'motoristas',
                        'motoristas.id',
                        'corridas.motorista_id'
                    )
                    .leftJoin(
                        'usuarios as usuario_motorista',
                        'usuario_motorista.id',
                        'motoristas.usuario_id'
                    )
                    .select(
                        'corridas.*',

                        // ==========================================
                        // DADOS DO MOTORISTA
                        // ==========================================

                        'motoristas.id as motorista_id_dados',
                        'motoristas.latitude as motorista_latitude',
                        'motoristas.longitude as motorista_longitude',
                        'motoristas.status as motorista_status',
                        'motoristas.online as motorista_online',

                        // ==========================================
                        // DADOS DO USUÁRIO MOTORISTA
                        // ==========================================

                        'usuario_motorista.id as motorista_usuario_id',
                        'usuario_motorista.nome as motorista_nome',
                        'usuario_motorista.telefone as motorista_telefone'
                    )
                    .orderBy(
                        'corridas.created_at',
                        'desc'
                    )
                    .first();

                if (!corrida) {

                    return response.json({
                        corrida: null
                    });

                }

                // ==========================================
                // ORGANIZA DADOS DO MOTORISTA
                // ==========================================

                const resposta = {
                    ...corrida,

                    motorista: corrida.motorista_id_dados
                        ? {
                            id: corrida.motorista_id_dados,
                            usuario_id: corrida.motorista_usuario_id,
                            nome: corrida.motorista_nome,
                            telefone: corrida.motorista_telefone,
                            latitude: corrida.motorista_latitude,
                            longitude: corrida.motorista_longitude,
                            status: corrida.motorista_status,
                            online: corrida.motorista_online
                        }
                        : null
                };

                // ==========================================
                // REMOVE CAMPOS AUXILIARES
                // ==========================================

                delete resposta.motorista_id_dados;
                delete resposta.motorista_usuario_id;
                delete resposta.motorista_nome;
                delete resposta.motorista_telefone;
                delete resposta.motorista_latitude;
                delete resposta.motorista_longitude;
                delete resposta.motorista_status;
                delete resposta.motorista_online;

                return response.json({
                    corrida: resposta
                });
            }

            // ==================================================
            // TIPO NÃO PERMITIDO
            // ==================================================

            return response.status(403).json({
                error:
                    'Tipo de usuário não autorizado.'
            });

        } catch (error) {

            console.error(
                'Erro ao buscar minha corrida:',
                error
            );

            return response.status(500).json({
                error:
                    'Erro ao buscar minha corrida.'
            });
        }
    },

    // ==================================================
    // HISTORICO DE CORRIDAS
    // ==================================================

    async historico(request, response) {
        try {
            const usuarioId = request.user.id;

            const usuario = await connection('usuarios')
            .where('id', usuarioId)
            .where('status', 'ATIVO')
            .first();

            if (!usuario) {
            return response.status(403).json({
                error: 'Usuário não autorizado.'
            });
            }

            if (usuario.tipo !== 'CLIENTE') {
            return response.status(403).json({
                error: 'Apenas clientes podem consultar o histórico.'
            });
            }

            const corridas = await connection('corridas')
            .where('cliente_id', usuarioId)
            .whereIn('status', [
                'FINALIZADA',
                'CANCELADA'
            ])
            .orderBy('created_at', 'desc');

            return response.json({
            corridas
            });

        } catch (error) {
            console.error(
            'Erro ao buscar histórico de corridas:',
            error
            );

            return response.status(500).json({
            error: 'Erro ao buscar histórico de corridas.'
            });
        }
    },

    async cancelar(request, response) {
        try {
            const usuarioId = request.user.id;

            const corrida = await connection('corridas')
            .where('id', request.params.id)
            .where('cliente_id', usuarioId)
            .whereIn('status', [
                'SOLICITADA',
                'ACEITA'
            ])
            .first();

            if (!corrida) {
            return response.status(400).json({
                error:
                'Corrida não encontrada ou não pode mais ser cancelada.'
            });
            }

            await connection('corridas')
            .where('id', corrida.id)
            .update({
                status: 'CANCELADA',
                updated_at: connection.fn.now()
            });

            const corridaAtualizada =
            await connection('corridas')
                .where('id', corrida.id)
                .first();

            return response.json({
            corrida: corridaAtualizada
            });

        } catch (error) {
            console.error(
            'Erro ao cancelar corrida:',
            error
            );

            return response.status(500).json({
            error: 'Erro ao cancelar corrida.'
            });
        }
    },
    
};