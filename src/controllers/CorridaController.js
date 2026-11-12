const connection = require('../database/connection');
const { randomUUID } = require('crypto');

const {
    despacharProximoMotorista,
    recusarOferta,
    limparTemporizadoresCorrida
} = require('../services/DespachoCorridas');

const { obterIO } = require('../socket');


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
                origem,
                destino
            } = request.body;

            const origemLatitude = Number(origem_latitude);
            const origemLongitude = Number(origem_longitude);
            const destinoLatitude = Number(destino_latitude);
            const destinoLongitude = Number(destino_longitude);

            // Valida coordenadas
            if (
                !coordenadasValidas(origemLatitude, origemLongitude) ||
                !coordenadasValidas(destinoLatitude, destinoLongitude)
            ) {
                return response.status(400).json({
                    error: 'Informe uma origem e um destino válidos.'
                });
            }

            // Valida endereço de destino
            if (
                !destino ||
                typeof destino !== 'string' ||
                !destino.trim()
            ) {
                return response.status(400).json({
                    error: 'Informe o endereço de destino.'
                });
            }

            // Verifica cliente autenticado
            const cliente = await connection('usuarios')
                .where({
                    id: request.user.id,
                    tipo: 'CLIENTE',
                    status: 'ATIVO'
                })
                .first();

            if (!cliente) {
                return response.status(403).json({
                    error: 'Usuário não autorizado para solicitar corridas.'
                });
            }

            // Busca categorias ativas
            const categorias = await connection('categorias_veiculos')
                .where('ativo', 1)
                .orderBy('preco_base', 'asc');

            if (!categorias.length) {
                return response.status(404).json({
                    error: 'Nenhuma categoria de veículo está disponível.'
                });
            }

            // Calcula a rota uma única vez
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

            // Cria uma cotação independente para cada categoria
            const opcoes = await connection.transaction(async trx => {
                const resultado = [];

                for (const categoria of categorias) {
                    const valorEstimado = calcularPreco(
                        categoria,
                        rota.distancia_metros,
                        rota.duracao_estimada_segundos
                    );

                    const cotacaoId = randomUUID();

                    await trx('cotacoes_corridas').insert({
                        id: cotacaoId,
                        cliente_id: request.user.id,
                        categoria_veiculo_id: categoria.id,

                        origem_latitude: origemLatitude,
                        origem_longitude: origemLongitude,

                        destino_latitude: destinoLatitude,
                        destino_longitude: destinoLongitude,

                        origem: origem ? origem.trim() : null,
                        destino: destino.trim(),

                        distancia_metros: rota.distancia_metros,
                        duracao_estimada_segundos:
                            rota.duracao_estimada_segundos,

                        valor_estimado: valorEstimado,

                        expira_em: trx.raw(
                            'DATE_ADD(NOW(), INTERVAL 10 MINUTE)'
                        )
                    });

                    resultado.push({
                        cotacao_id: cotacaoId,

                        categoria_veiculo_id: categoria.id,
                        nome: categoria.nome,
                        descricao: categoria.descricao,

                        capacidade_passageiros:
                            categoria.capacidade_passageiros,

                        distancia_metros: rota.distancia_metros,
                        duracao_estimada_segundos:
                            rota.duracao_estimada_segundos,

                        valor_estimado: valorEstimado,

                        validade_minutos: 10
                    });
                }

                return resultado;
            });

            console.log('=================================');
            console.log('COTAÇÕES DE CORRIDA CRIADAS');
            console.log('Cliente:', request.user.id);
            console.log('Distância:', rota.distancia_metros);
            console.log('Duração:', rota.duracao_estimada_segundos);
            console.log('Opções:', opcoes);
            console.log('=================================');

            return response.json({
                distancia_metros: rota.distancia_metros,
                duracao_estimada_segundos:
                    rota.duracao_estimada_segundos,
                opcoes
            });

        } catch (error) {
            console.error('Erro ao calcular estimativa:', error);

            return response.status(500).json({
                error: 'Não foi possível calcular a estimativa da corrida.'
            });
        }
    },

    // ==========================================================
    // SOLICITAR CORRIDA - CLIENTE
    // ==========================================================

    async store(request, response) {
        try {
            const { cotacao_id } = request.body;
            const clienteId = request.user.id;

            // Valida identificador da cotação
            if (
                typeof cotacao_id !== 'string' ||
                !cotacao_id.trim()
            ) {
                return response.status(400).json({
                    error: 'Identificador da cotação não informado.'
                });
            }

            // Confirma cliente ativo
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

            // Cria corrida e consome a cotação na mesma transação
            const resultado = await connection.transaction(async trx => {

                // Bloqueia a cotação durante a operação
                const cotacao = await trx('cotacoes_corridas')
                    .where('id', cotacao_id)
                    .where('cliente_id', clienteId)
                    .whereNull('utilizada_em')
                    .where('expira_em', '>', trx.fn.now())
                    .forUpdate()
                    .first();

                if (!cotacao) {
                    return {
                        erro: 'Cotação não encontrada, expirada ou já utilizada.',
                        status: 409
                    };
                }

                // Confirma que a categoria ainda está ativa
                const categoria = await trx('categorias_veiculos')
                    .where('id', cotacao.categoria_veiculo_id)
                    .where('ativo', 1)
                    .first();

                if (!categoria) {
                    return {
                        erro: 'A categoria desta cotação não está mais disponível.',
                        status: 409
                    };
                }

                // Gera identificador da corrida
                const corridaId = randomUUID();

                // Cria a corrida usando exclusivamente os dados da cotação
                await trx('corridas').insert({
                    id: corridaId,

                    cliente_id: clienteId,

                    origem_latitude: cotacao.origem_latitude,
                    origem_longitude: cotacao.origem_longitude,

                    destino_latitude: cotacao.destino_latitude,
                    destino_longitude: cotacao.destino_longitude,

                    origem: cotacao.origem,
                    destino: cotacao.destino,

                    categoria_veiculo_id:
                        cotacao.categoria_veiculo_id,

                    distancia_metros:
                        cotacao.distancia_metros,

                    duracao_estimada_segundos:
                        cotacao.duracao_estimada_segundos,

                    valor_estimado:
                        cotacao.valor_estimado,

                    motorista_id: null,
                    status: 'SOLICITADA',
                    valor: null
                });

                // Marca a cotação como utilizada
                const quantidadeAtualizada = await trx('cotacoes_corridas')
                    .where('id', cotacao.id)
                    .where('cliente_id', clienteId)
                    .whereNull('utilizada_em')
                    .update({
                        utilizada_em: trx.fn.now(),
                        corrida_id: corridaId,
                        updated_at: trx.fn.now()
                    });

                if (quantidadeAtualizada !== 1) {
                    throw new Error(
                        'Não foi possível confirmar o consumo da cotação.'
                    );
                }

                const corrida = await trx('corridas')
                    .where('id', corridaId)
                    .first();

                return {
                    corrida
                };
            });

            if (resultado.erro) {
                return response.status(resultado.status).json({
                    error: resultado.erro
                });
            }

            const corridaId = resultado.corrida.id;

            console.log('=================================');
            console.log('CORRIDA CRIADA COM PREÇO CONTRATADO');
            console.log('Corrida:', corridaId);
            console.log('Cotação:', cotacao_id);
            console.log('Valor:', resultado.corrida.valor_estimado);
            console.log('=================================');

            // Despacha a corrida para um motorista
            try {
                const despacho = await despacharProximoMotorista(
                    corridaId
                );

                console.log(
                    'Resultado do despacho:',
                    corridaId,
                    despacho?.tipo
                );
            } catch (erroDespacho) {
                // A corrida já está gravada.
                // Uma falha no despacho não deve provocar duplicação.
                console.error(
                    'Corrida criada, mas houve erro no despacho:',
                    corridaId,
                    erroDespacho
                );
            }

            // Busca corrida atualizada
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

            const motorista = await connection('motoristas')
                .join('usuarios', 'usuarios.id', 'motoristas.usuario_id')
                .where('motoristas.usuario_id', usuarioId)
                .where('usuarios.tipo', 'MOTORISTA')
                .where('usuarios.status', 'ATIVO')
                .where('motoristas.status', 'APROVADO')
                .select('motoristas.id', 'motoristas.online')
                .first();

            if (!motorista) {
                return response.status(403).json({
                    error: 'Cadastro de motorista não encontrado ou não aprovado.'
                });
            }

            if (!motorista.online) {
                return response.status(403).json({
                    error: 'O motorista precisa estar online.'
                });
            }

            const tentativa = await connection('tentativas_corrida')
                .join(
                    'corridas',
                    'corridas.id',
                    'tentativas_corrida.corrida_id'
                )
                .where('tentativas_corrida.motorista_id', motorista.id)
                .where('tentativas_corrida.status', 'PENDENTE')
                .where('tentativas_corrida.data_expiracao', '>', connection.fn.now())
                .where('corridas.status', 'SOLICITADA')
                .select(
                    'tentativas_corrida.id as tentativa_id',
                    'tentativas_corrida.data_expiracao',
                    'corridas.*'
                )
                .first();

            return response.json({
                corridas: tentativa ? [{
                    ...tentativa,
                    tentativa_id: tentativa.tentativa_id,
                    data_expiracao: tentativa.data_expiracao
                }] : []
            });
        } catch (error) {
            console.error('Erro ao buscar ofertas:', error);

            return response.status(500).json({
                error: 'Erro ao buscar ofertas de corridas.'
            });
        }
    },

    // ==========================================================
    // MOTORISTA ACEITA CORRIDA
    // ==========================================================

    async aceitar(request, response) {
        try {
            const usuarioId = request.user.id;
            const { id: corridaId } = request.params;

            const motorista = await connection('motoristas')
                .join('usuarios', 'usuarios.id', 'motoristas.usuario_id')
                .where('motoristas.usuario_id', usuarioId)
                .where('usuarios.tipo', 'MOTORISTA')
                .where('usuarios.status', 'ATIVO')
                .where('motoristas.status', 'APROVADO')
                .select('motoristas.id', 'motoristas.online')
                .first();

            if (!motorista) {
                return response.status(403).json({
                    error: 'Motorista não encontrado ou não aprovado.'
                });
            }

            if (!motorista.online) {
                return response.status(403).json({
                    error: 'O motorista precisa estar online para aceitar.'
                });
            }

            const resultado = await connection.transaction(async trx => {
                const corrida = await trx('corridas')
                    .where('id', corridaId)
                    .forUpdate()
                    .first();

                if (!corrida || corrida.status !== 'SOLICITADA') {
                    return { erro: 'Esta corrida não está mais disponível.' };
                }

                const tentativa = await trx('tentativas_corrida')
                    .where('corrida_id', corridaId)
                    .where('motorista_id', motorista.id)
                    .where('status', 'PENDENTE')
                    .where('data_expiracao', '>', trx.fn.now())
                    .forUpdate()
                    .first();

                if (!tentativa) {
                    return {
                        erro: 'Esta oferta expirou ou não foi destinada a você.'
                    };
                }

                const corridaAtiva = await trx('corridas')
                    .where('motorista_id', motorista.id)
                    .whereIn('status', ['ACEITA', 'EM_ANDAMENTO'])
                    .first();

                if (corridaAtiva) {
                    return {
                        erro: 'Você já possui uma corrida aceita ou em andamento.'
                    };
                }

                // Confere novamente a categoria do veículo ativo.
                const possuiVeiculo = await trx('veiculos')
                    .where('motorista_id', motorista.id)
                    .where('categoria_id', corrida.categoria_veiculo_id)
                    .where('ativo', 1)
                    .first();

                if (!possuiVeiculo) {
                    return {
                        erro: 'Você não possui veículo ativo nesta categoria.'
                    };
                }

                await trx('corridas')
                    .where('id', corridaId)
                    .where('status', 'SOLICITADA')
                    .update({
                        motorista_id: motorista.id,
                        status: 'ACEITA',
                        updated_at: trx.fn.now()
                    });

                await trx('tentativas_corrida')
                    .where('id', tentativa.id)
                    .update({
                        status: 'ACEITA',
                        data_resposta: trx.fn.now(),
                        updated_at: trx.fn.now()
                    });

                // Cancela qualquer outra oferta pendente para esta corrida.
                await trx('tentativas_corrida')
                    .where('corrida_id', corridaId)
                    .where('status', 'PENDENTE')
                    .update({
                        status: 'CANCELADA',
                        data_resposta: trx.fn.now(),
                        updated_at: trx.fn.now()
                    });

                const corridaAtualizada = await trx('corridas')
                    .where('id', corridaId)
                    .first();

                return {
                    corrida: corridaAtualizada,
                    tentativaId: tentativa.id
                };
            });

            if (resultado.erro) {
                return response.status(409).json({
                    error: resultado.erro
                });
            }

            // A corrida já foi aceita no banco.
            // Encerra todos os temporizadores associados a ela.
            limparTemporizadoresCorrida(corridaId);

            const io = obterIO();

            io.to(`usuario:${resultado.corrida.cliente_id}`)
                .emit('corrida:aceita', {
                    corrida: resultado.corrida
                });

            io.to(`usuario:${usuarioId}`)
                .emit('corrida:aceite_confirmado', {
                    corrida: resultado.corrida
                });

            return response.json({
                message: 'Corrida aceita com sucesso.',
                corrida: resultado.corrida
            });
        } catch (error) {
            console.error('Erro ao aceitar corrida:', error);

            return response.status(500).json({
                error: 'Erro ao aceitar corrida.'
            });
        }
    },

    // ==========================================================
    // MOTORISTA RECUSA CORRIDA
    // ==========================================================

    async recusar(request, response) {
        try {
            const usuarioId = request.user.id;
            const { id: corridaId } = request.params;

            const motorista = await connection('motoristas')
                .join('usuarios', 'usuarios.id', 'motoristas.usuario_id')
                .where('motoristas.usuario_id', usuarioId)
                .where('usuarios.tipo', 'MOTORISTA')
                .where('usuarios.status', 'ATIVO')
                .where('motoristas.status', 'APROVADO')
                .select('motoristas.id')
                .first();

            if (!motorista) {
                return response.status(403).json({
                    error: 'Motorista não encontrado ou não aprovado.'
                });
            }

            const recusada = await recusarOferta(
                corridaId,
                motorista.id
            );

            if (!recusada) {
                return response.status(409).json({
                    error: 'A oferta não existe, expirou ou já foi respondida.'
                });
            }

            return response.json({
                message: 'Oferta recusada. Buscando o próximo motorista.'
            });
        } catch (error) {
            console.error('Erro ao recusar oferta:', error);

            return response.status(500).json({
                error: 'Erro ao recusar a oferta.'
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

            // CONFIRMA MOTORISTA
            const motorista = await connection('motoristas')
                .join(
                    'usuarios',
                    'usuarios.id',
                    'motoristas.usuario_id'
                )
                .where('motoristas.usuario_id', usuarioId)
                .where('usuarios.tipo', 'MOTORISTA')
                .where('usuarios.status', 'ATIVO')
                .select('motoristas.id')
                .first();

            if (!motorista) {
                return response.status(403).json({
                    error: 'Cadastro de motorista não encontrado ou usuário não autorizado.'
                });
            }

            // FINALIZA CORRIDA EM TRANSAÇÃO
            const corrida = await connection.transaction(async (trx) => {

                // Busca e bloqueia a corrida
                const corridaAtual = await trx('corridas')
                    .where('id', id)
                    .where('motorista_id', motorista.id)
                    .forUpdate()
                    .first();

                if (
                    !corridaAtual ||
                    corridaAtual.status !== 'EM_ANDAMENTO'
                ) {
                    return null;
                }

                // O preço final é exatamente o preço contratado
                const valorContratado = corridaAtual.valor_estimado;

                if (
                    valorContratado === null ||
                    !Number.isFinite(Number(valorContratado))
                ) {
                    throw new Error(
                        'A corrida não possui um valor contratado válido.'
                    );
                }

                // Atualiza a corrida
                await trx('corridas')
                    .where('id', id)
                    .where('motorista_id', motorista.id)
                    .where('status', 'EM_ANDAMENTO')
                    .update({
                        status: 'FINALIZADA',
                        valor_final: valorContratado,
                        updated_at: trx.fn.now()
                    });

                // Retorna os dados atualizados
                return await trx('corridas')
                    .where('id', id)
                    .first();
            });

            if (!corrida) {
                return response.status(409).json({
                    error: 'Esta corrida não pode ser finalizada. Verifique se ela pertence a você e está em andamento.'
                });
            }

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
            const corridaId = request.params.id;

            const resultado = await connection.transaction(async trx => {
                const corrida = await trx('corridas')
                    .where('id', corridaId)
                    .where('cliente_id', usuarioId)
                    .forUpdate()
                    .first();

                if (
                    !corrida ||
                    !['SOLICITADA', 'ACEITA'].includes(corrida.status)
                ) {
                    return {
                        erro: 'Corrida não encontrada ou não pode mais ser cancelada.'
                    };
                }

                // Obtém as tentativas pendentes antes de encerrá-las.
                const tentativasPendentes = await trx('tentativas_corrida')
                    .where('corrida_id', corridaId)
                    .where('status', 'PENDENTE')
                    .select('motorista_id');

                const motoristasIds = new Set(
                    tentativasPendentes.map(t => String(t.motorista_id))
                );

                // Se já havia um motorista atribuído, ele também
                // precisa receber o aviso de cancelamento.
                if (corrida.motorista_id) {
                    motoristasIds.add(String(corrida.motorista_id));
                }

                const quantidade = await trx('corridas')
                    .where('id', corridaId)
                    .where('cliente_id', usuarioId)
                    .whereIn('status', ['SOLICITADA', 'ACEITA'])
                    .update({
                        status: 'CANCELADA',
                        updated_at: trx.fn.now()
                    });

                if (!quantidade) {
                    return {
                        erro: 'A corrida já foi alterada e não pode ser cancelada.'
                    };
                }

                // Encerra todas as ofertas ainda pendentes.
                await trx('tentativas_corrida')
                    .where('corrida_id', corridaId)
                    .where('status', 'PENDENTE')
                    .update({
                        status: 'CANCELADA',
                        data_resposta: trx.fn.now(),
                        updated_at: trx.fn.now()
                    });

                const corridaAtualizada = await trx('corridas')
                    .where('id', corridaId)
                    .first();

                let motoristas = [];

                if (motoristasIds.size > 0) {
                    motoristas = await trx('motoristas')
                        .whereIn('id', [...motoristasIds])
                        .select('id', 'usuario_id');
                }

                return {
                    corrida: corridaAtualizada,
                    motoristas
                };
            });

            if (resultado.erro) {
                return response.status(409).json({
                    error: resultado.erro
                });
            }

            // Impede que temporizadores antigos avancem o despacho.
            limparTemporizadoresCorrida(corridaId);

            const io = obterIO();

            // Notifica os motoristas que tinham uma oferta pendente
            // e também o motorista já atribuído, caso exista.
            for (const motorista of resultado.motoristas) {
                io.to(`usuario:${motorista.usuario_id}`)
                    .emit('corrida:cancelada', {
                        corrida_id: corridaId,
                        mensagem: 'O passageiro cancelou esta corrida.'
                    });
            }

            // Confirma o cancelamento ao passageiro por Socket.IO.
            io.to(`usuario:${usuarioId}`)
                .emit('corrida:cancelada', {
                    corrida: resultado.corrida,
                    mensagem: 'Sua corrida foi cancelada.'
                });

            return response.json({
                message: 'Corrida cancelada com sucesso.',
                corrida: resultado.corrida
            });

        } catch (error) {
            console.error('Erro ao cancelar corrida:', error);

            return response.status(500).json({
                error: 'Erro ao cancelar corrida.'
            });
        }
    },
    
};