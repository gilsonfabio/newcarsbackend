const connection = require('../database/connection');
const { randomUUID } = require('crypto');

// ==========================================================
// CALCULA DISTÂNCIA E DURAÇÃO PELA GOOGLE ROUTES API
// ==========================================================

async function calcularRota(origem, destino) {
    const apiKey = process.env.GOOGLE_ROUTES_API_KEY;

    if (!apiKey) {
        throw new Error(
            'GOOGLE_ROUTES_API_KEY não configurada no backend.'
        );
    }

    const resposta = await fetch(
        'https://routes.googleapis.com/directions/v2:computeRoutes',
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': apiKey,
                'X-Goog-FieldMask':
                    'routes.distanceMeters,routes.duration'
            },
            body: JSON.stringify({
                origin: {
                    location: {
                        latLng: {
                            latitude: Number(origem.latitude),
                            longitude: Number(origem.longitude)
                        }
                    }
                },
                destination: {
                    location: {
                        latLng: {
                            latitude: Number(destino.latitude),
                            longitude: Number(destino.longitude)
                        }
                    }
                },
                travelMode: 'DRIVE',
                routingPreference: 'TRAFFIC_AWARE'
            })
        }
    );

    if (!resposta.ok) {
        const detalhe = await resposta.text();

        console.error(
            'Erro Google Routes API:',
            resposta.status,
            detalhe
        );

        throw new Error(
            'Não foi possível calcular a rota pela Google Routes API.'
        );
    }

    const dados = await resposta.json();
    const rota = dados.routes?.[0];

    if (
        !rota ||
        !Number.isFinite(Number(rota.distanceMeters)) ||
        !rota.duration
    ) {
        throw new Error(
            'A Google Routes API não retornou uma rota válida.'
        );
    }

    const distanciaMetros = Math.round(
        Number(rota.distanceMeters)
    );

    const duracaoSegundos = Math.ceil(
        Number.parseFloat(rota.duration.replace('s', ''))
    );

    if (
        distanciaMetros <= 0 ||
        !Number.isFinite(duracaoSegundos) ||
        duracaoSegundos <= 0
    ) {
        throw new Error(
            'A distância ou duração retornada pela API é inválida.'
        );
    }

    return {
        distancia_metros: distanciaMetros,
        duracao_estimada_segundos: duracaoSegundos
    };
}

// ==========================================================
// CALCULA PREÇO DA CATEGORIA
// ==========================================================

function calcularPreco(categoria, distanciaMetros, duracaoSegundos) {
    const distanciaKm = distanciaMetros / 1000;
    const duracaoMinutos = duracaoSegundos / 60;

    const precoBase = Number(categoria.preco_base);
    const precoKm = Number(categoria.preco_km);
    const precoMinuto = Number(categoria.preco_minuto);
    const taxaMinima = Number(categoria.taxa_minima);

    const valores = [
        precoBase,
        precoKm,
        precoMinuto,
        taxaMinima
    ];

    if (
        !valores.every(Number.isFinite) ||
        valores.some(valor => valor < 0)
    ) {
        throw new Error(
            `Valores de preço inválidos na categoria ${categoria.nome}.`
        );
    }

    const calculado =
        precoBase +
        distanciaKm * precoKm +
        duracaoMinutos * precoMinuto;

    return Number(
        Math.max(taxaMinima, calculado).toFixed(2)
    );
}

// ==========================================================
// VALIDAÇÃO DAS COORDENADAS
// ==========================================================

function coordenadasValidas(latitude, longitude) {
    return (
        Number.isFinite(Number(latitude)) &&
        Number.isFinite(Number(longitude)) &&
        Number(latitude) >= -90 &&
        Number(latitude) <= 90 &&
        Number(longitude) >= -180 &&
        Number(longitude) <= 180
    );
}

module.exports = {

    async estimativa(request, response) {
        try {
            const {
                origem_latitude,
                origem_longitude,
                destino_latitude,
                destino_longitude,
                destino,
            } = request.body;

            console.log('=================================');
            console.log('ESTIMATIVA - DADOS RECEBIDOS');
            console.log('origem_latitude:', origem_latitude);
            console.log('origem_longitude:', origem_longitude);
            console.log('destino_latitude:', destino_latitude);
            console.log('destino_longitude:', destino_longitude);
            console.log('destino:', destino);
            console.log('=================================');

            const origemLatitude = Number(origem_latitude);
            const origemLongitude = Number(origem_longitude);
            const destinoLatitude = Number(destino_latitude);
            const destinoLongitude = Number(destino_longitude);

            /*
            * Validação das coordenadas.
            */
            const coordenadasValidas = (
                latitude,
                longitude
            ) => {
                return (
                    Number.isFinite(latitude) &&
                    Number.isFinite(longitude) &&
                    latitude >= -90 &&
                    latitude <= 90 &&
                    longitude >= -180 &&
                    longitude <= 180
                );
            };

            if (
                !coordenadasValidas(
                    origemLatitude,
                    origemLongitude
                ) ||
                !coordenadasValidas(
                    destinoLatitude,
                    destinoLongitude
                )
            ) {
                console.log(
                    'COORDENADAS INVÁLIDAS'
                );

                return response.status(400).json({
                    error:
                        'Informe uma origem e um destino válidos.',
                });
            }

            if (
                !destino ||
                typeof destino !== 'string' ||
                !destino.trim()
            ) {
                return response.status(400).json({
                    error:
                        'Informe o endereço de destino.',
                });
            }

            /*
            * Verifica se o usuário autenticado
            * é um cliente ativo.
            */
            const cliente = await connection(
                'usuarios'
            )
                .where({
                    id: request.user.id,
                    tipo: 'CLIENTE',
                    status: 'ATIVO',
                })
                .first();

            if (!cliente) {
                return response.status(403).json({
                    error:
                        'Usuário não autorizado para solicitar corridas.',
                });
            }

            /*
            * Busca categorias ativas.
            */
            const categorias = await connection(
                'categorias_veiculos'
            )
                .where('ativo', 1)
                .orderBy('preco_base', 'asc');

            if (!categorias.length) {
                return response.status(404).json({
                    error:
                        'Nenhuma categoria de veículo está disponível.',
                });
            }

            /*
            * Calcula a rota usando Google Routes API.
            */
            const rota = await calcularRota(
                {
                    latitude: origemLatitude,
                    longitude: origemLongitude,
                },
                {
                    latitude: destinoLatitude,
                    longitude: destinoLongitude,
                }
            );

            /*
            * Calcula o preço para cada categoria.
            */
            const opcoes = categorias.map(
                categoria => ({
                    categoria_veiculo_id:
                        categoria.id,

                    nome: categoria.nome,

                    descricao:
                        categoria.descricao,

                    capacidade_passageiros:
                        categoria.capacidade_passageiros,

                    distancia_metros:
                        rota.distancia_metros,

                    duracao_estimada_segundos:
                        rota.duracao_estimada_segundos,

                    valor_estimado:
                        calcularPreco(
                            categoria,
                            rota.distancia_metros,
                            rota.duracao_estimada_segundos
                        ),
                })
            );

            console.log(
                '================================='
            );

            console.log(
                'ESTIMATIVA CALCULADA'
            );

            console.log(
                'Distância:',
                rota.distancia_metros
            );

            console.log(
                'Duração:',
                rota.duracao_estimada_segundos
            );

            console.log(
                'Opções:',
                opcoes
            );

            console.log(
                '================================='
            );

            return response.json({
                distancia_metros:
                    rota.distancia_metros,

                duracao_estimada_segundos:
                    rota.duracao_estimada_segundos,

                opcoes,
            });

        } catch (error) {
            console.error(
                'Erro ao calcular estimativa:',
                error
            );

            return response.status(500).json({
                error:
                    'Não foi possível calcular a estimativa da corrida.',
            });
        }
    },

    // ==========================================================
    // SOLICITAR CORRIDA - CLIENTE
    // ==========================================================

    async store(request, response) {
        try {
            const {
                origem_latitude,
                origem_longitude,
                destino_latitude,
                destino_longitude,
                destino,
                categoria_veiculo_id
            } = request.body;

            const clienteId = request.user.id;

            console.log('=================================');
            console.log('SOLICITAR CORRIDA - DADOS RECEBIDOS');
            console.log('origem_latitude:', origem_latitude);
            console.log('origem_longitude:', origem_longitude);
            console.log('destino_latitude:', destino_latitude);
            console.log('destino_longitude:', destino_longitude);
            console.log('destino:', destino);
            console.log('categoria_veiculo_id:', categoria_veiculo_id);
            console.log('=================================');

            // ==================================================
            // CONVERTE COORDENADAS PARA NUMBER
            // ==================================================

            const origemLatitude = Number(origem_latitude);
            const origemLongitude = Number(origem_longitude);
            const destinoLatitude = Number(destino_latitude);
            const destinoLongitude = Number(destino_longitude);

            // ==================================================
            // VALIDA ORIGEM
            // ==================================================

            if (
                !coordenadasValidas(
                    origemLatitude,
                    origemLongitude
                )
            ) {
                console.log(
                    'ORIGEM INVÁLIDA:',
                    origemLatitude,
                    origemLongitude
                );

                return response.status(400).json({
                    error:
                        'Informe uma origem com coordenadas válidas.'
                });
            }

            // ==================================================
            // VALIDA DESTINO
            // ==================================================

            if (
                !coordenadasValidas(
                    destinoLatitude,
                    destinoLongitude
                )
            ) {
                console.log(
                    'DESTINO INVÁLIDO:',
                    destinoLatitude,
                    destinoLongitude
                );

                return response.status(400).json({
                    error:
                        'Informe um destino com coordenadas válidas.'
                });
            }

            // ==================================================
            // VALIDA ENDEREÇO
            // ==================================================

            if (
                !destino ||
                typeof destino !== 'string' ||
                !destino.trim()
            ) {
                return response.status(400).json({
                    error:
                        'Informe o endereço de destino.'
                });
            }

            // ==================================================
            // VALIDA CATEGORIA
            // ==================================================

            if (
                typeof categoria_veiculo_id !== 'string' ||
                !categoria_veiculo_id.trim()
            ) {
                return response.status(400).json({
                    error:
                        'Selecione uma categoria de veículo.'
                });
            }

            // ==================================================
            // VERIFICA CLIENTE
            // ==================================================

            const cliente = await connection('usuarios')
                .where('id', clienteId)
                .where('tipo', 'CLIENTE')
                .where('status', 'ATIVO')
                .first();

            if (!cliente) {
                return response.status(403).json({
                    error:
                        'Usuário não autorizado a solicitar corridas.'
                });
            }

            // ==================================================
            // BUSCA CATEGORIA
            // ==================================================

            const categoria = await connection(
                'categorias_veiculos'
            )
                .where(
                    'id',
                    categoria_veiculo_id
                )
                .where(
                    'ativo',
                    1
                )
                .first();

            if (!categoria) {
                return response.status(400).json({
                    error:
                        'A categoria selecionada não existe ou está inativa.'
                });
            }

            // ==================================================
            // CALCULA NOVAMENTE A ROTA
            // ==================================================
            //
            // IMPORTANTE:
            // Não confiamos nos valores calculados pelo aplicativo.
            // O backend calcula novamente usando a Google Routes API.
            //

            const rota = await calcularRota(
                {
                    latitude: origemLatitude,
                    longitude: origemLongitude
                },
                {
                    latitude: destinoLatitude,
                    longitude: destinoLongitude
                }
            );

            // ==================================================
            // CALCULA NOVAMENTE O PREÇO
            // ==================================================

            const valorEstimado = calcularPreco(
                categoria,
                rota.distancia_metros,
                rota.duracao_estimada_segundos
            );

            console.log('=================================');
            console.log('CORRIDA - VALORES CALCULADOS PELO SERVIDOR');
            console.log(
                'Distância:',
                rota.distancia_metros,
                'metros'
            );
            console.log(
                'Duração:',
                rota.duracao_estimada_segundos,
                'segundos'
            );
            console.log(
                'Categoria:',
                categoria.nome
            );
            console.log(
                'Valor estimado:',
                valorEstimado
            );
            console.log('=================================');

            // ==================================================
            // GERA ID DA CORRIDA
            // ==================================================

            const corridaId = randomUUID();

            // ==================================================
            // CRIA CORRIDA
            // ==================================================

            await connection('corridas').insert({
                id: corridaId,

                cliente_id: clienteId,

                origem_latitude: origemLatitude,
                origem_longitude: origemLongitude,

                destino: destino.trim(),

                destino_latitude: destinoLatitude,
                destino_longitude: destinoLongitude,

                categoria_veiculo_id: categoria.id,

                distancia_metros:
                    rota.distancia_metros,

                duracao_estimada_segundos:
                    rota.duracao_estimada_segundos,

                valor_estimado:
                    valorEstimado,

                motorista_id: null,

                status: 'SOLICITADA',

                valor: null
            });

            // ==================================================
            // BUSCA CORRIDA CRIADA
            // ==================================================

            const corrida = await connection(
                'corridas'
            )
                .where(
                    'id',
                    corridaId
                )
                .first();

            // ==================================================
            // RESPOSTA
            // ==================================================

            return response.status(201).json({
                message:
                    'Corrida solicitada com sucesso.',

                corrida
            });

        } catch (error) {

            console.error(
                'Erro ao solicitar corrida:',
                error
            );

            return response.status(500).json({
                error:
                    'Erro ao solicitar corrida.'
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

                // ==============================================
                // BUSCA A CORRIDA DO CLIENTE
                // ==============================================

                const corrida = await connection('corridas')
                    .where(
                        'cliente_id',
                        usuarioId
                    )
                    .whereIn(
                        'status',
                        [
                            'SOLICITADA',
                            'ACEITA',
                            'EM_ANDAMENTO'
                        ]
                    )
                    .orderBy(
                        'created_at',
                        'desc'
                    )
                    .first();

                if (!corrida) {

                    return response.json({
                        corrida: null
                    });

                }

                // ==============================================
                // BUSCA O MOTORISTA
                // ==============================================

                let motorista = null;

                if (corrida.motorista_id) {

                    const motoristaBanco = await connection('motoristas')
                        .where(
                            'id',
                            corrida.motorista_id
                        )
                        .first();

                    if (motoristaBanco) {

                        // ==========================================
                        // BUSCA DADOS DO USUÁRIO DO MOTORISTA
                        // ==========================================

                        const usuarioMotorista = await connection('usuarios')
                            .where(
                                'id',
                                motoristaBanco.usuario_id
                            )
                            .first();

                        motorista = {
                            id: motoristaBanco.id,
                            usuario_id: motoristaBanco.usuario_id,

                            nome: usuarioMotorista
                                ? usuarioMotorista.nome
                                : null,

                            telefone: usuarioMotorista
                                ? usuarioMotorista.telefone
                                : null,

                            latitude: motoristaBanco.latitude,
                            longitude: motoristaBanco.longitude,

                            status: motoristaBanco.status,
                            online: motoristaBanco.online
                        };
                    }
                }

                // ==============================================
                // LOG DE DEBUG
                // ==============================================

                console.log('======================================');
                console.log('MINHA CORRIDA - CLIENTE');
                console.log('Corrida:', corrida.id);
                console.log('Status:', corrida.status);
                console.log('Motorista ID na corrida:', corrida.motorista_id);
                console.log('Motorista encontrado:', motorista);
                console.log('======================================');

                // ==============================================
                // RESPOSTA
                // ==============================================

                return response.json({
                    corrida: {
                        ...corrida,
                        motorista
                    }
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