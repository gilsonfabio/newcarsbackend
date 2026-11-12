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
            const {
                cotacao_id,
                modalidade,
                forma_pagamento
            } = request.body;

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

            // Valida modalidade
            const modalidadesPermitidas = [
                'PRESENCIAL',
                'ONLINE'
            ];

            if (!modalidadesPermitidas.includes(modalidade)) {
                return response.status(400).json({
                    error: 'Modalidade de pagamento inválida.'
                });
            }

            // Valida forma de pagamento
            const formasPermitidas = [
                'DINHEIRO',
                'PIX',
                'CARTAO'
            ];

            if (!formasPermitidas.includes(forma_pagamento)) {
                return response.status(400).json({
                    error: 'Forma de pagamento inválida.'
                });
            }

            // Dinheiro só pode ser presencial
            if (
                modalidade === 'ONLINE' &&
                forma_pagamento === 'DINHEIRO'
            ) {
                return response.status(400).json({
                    error: 'Pagamento em dinheiro só pode ser presencial.'
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

            // Cria corrida, pagamento e consome cotação na mesma transação
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

                // Gera identificadores
                const corridaId = randomUUID();
                const pagamentoId = randomUUID();

                // Valor contratado na cotação
                const valorContratado = cotacao.valor_estimado;

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

                    valor_estimado: valorContratado,

                    motorista_id: null,
                    status: 'SOLICITADA',
                    valor: null
                });

                // Cria o pagamento inicialmente pendente.
                // A comissão será definida quando o motorista aceitar.
                await trx('pagamentos_corridas').insert({
                    id: pagamentoId,
                    corrida_id: corridaId,

                    modalidade,
                    forma_pagamento,

                    status: 'PENDENTE',

                    valor_bruto: valorContratado,

                    percentual_comissao: 0,
                    valor_comissao: 0,

                    // Temporariamente igual ao valor bruto.
                    // Será atualizado com a comissão do motorista
                    // quando ele aceitar a corrida.
                    valor_liquido: valorContratado,

                    chave_idempotencia: `corrida:${corridaId}`,

                    observacao: 'Pagamento criado na solicitação da corrida.'
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

                const pagamento = await trx('pagamentos_corridas')
                    .where('id', pagamentoId)
                    .first();

                return {
                    corrida,
                    pagamento
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
            console.log('Pagamento:', resultado.pagamento.id);
            console.log('Modalidade:', modalidade);
            console.log('Forma:', forma_pagamento);
            console.log('Status pagamento:', resultado.pagamento.status);
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
                // A corrida e o pagamento já estão gravados.
                // Uma falha no despacho não deve provocar duplicação.
                console.error(
                    'Corrida criada, mas houve erro no despacho:',
                    corridaId,
                    erroDespacho
                );
            }

            // Busca corrida e pagamento atualizados
            const corrida = await connection('corridas')
                .where('id', corridaId)
                .first();

            const pagamento = await connection('pagamentos_corridas')
                .where('corrida_id', corridaId)
                .first();

            return response.status(201).json({
                message: 'Corrida solicitada com sucesso.',
                corrida,
                pagamento
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

            // Localiza motorista e sua graduação atual
            const motorista = await connection('motoristas')
                .join(
                    'usuarios',
                    'usuarios.id',
                    'motoristas.usuario_id'
                )
                .leftJoin(
                    'graduacoes_motoristas as gm',
                    'gm.id',
                    'motoristas.graduacao_id'
                )
                .where('motoristas.usuario_id', usuarioId)
                .where('usuarios.tipo', 'MOTORISTA')
                .where('usuarios.status', 'ATIVO')
                .where('motoristas.status', 'APROVADO')
                .select(
                    'motoristas.id',
                    'motoristas.online',
                    'motoristas.graduacao_id',
                    'motoristas.percentual_comissao',
                    'gm.nome as graduacao_nome',
                    'gm.percentual_comissao as percentual_graduacao'
                )
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

            // Obtém a comissão individual do motorista.
            // Se estiver nula, utiliza o percentual da graduação.
            const percentualComissao = Number(
                motorista.percentual_comissao ??
                motorista.percentual_graduacao
            );

            if (
                !motorista.graduacao_id ||
                !motorista.graduacao_nome ||
                !Number.isFinite(percentualComissao) ||
                percentualComissao < 0 ||
                percentualComissao > 100
            ) {
                return response.status(409).json({
                    error: 'A graduação ou comissão do motorista não está configurada corretamente.'
                });
            }

            const resultado = await connection.transaction(async trx => {

                // Bloqueia a corrida durante a aceitação
                const corrida = await trx('corridas')
                    .where('id', corridaId)
                    .forUpdate()
                    .first();

                if (!corrida || corrida.status !== 'SOLICITADA') {
                    return {
                        erro: 'Esta corrida não está mais disponível.',
                        status: 409
                    };
                }

                // Confirma que a oferta foi destinada ao motorista
                const tentativa = await trx('tentativas_corrida')
                    .where('corrida_id', corridaId)
                    .where('motorista_id', motorista.id)
                    .where('status', 'PENDENTE')
                    .where('data_expiracao', '>', trx.fn.now())
                    .forUpdate()
                    .first();

                if (!tentativa) {
                    return {
                        erro: 'Esta oferta expirou ou não foi destinada a você.',
                        status: 409
                    };
                }

                // Verifica se o motorista já possui corrida ativa
                const corridaAtiva = await trx('corridas')
                    .where('motorista_id', motorista.id)
                    .whereIn('status', ['ACEITA', 'EM_ANDAMENTO'])
                    .first();

                if (corridaAtiva) {
                    return {
                        erro: 'Você já possui uma corrida aceita ou em andamento.',
                        status: 409
                    };
                }

                // Confere novamente a categoria do veículo ativo
                const possuiVeiculo = await trx('veiculos')
                    .where('motorista_id', motorista.id)
                    .where('categoria_id', corrida.categoria_veiculo_id)
                    .where('ativo', 1)
                    .first();

                if (!possuiVeiculo) {
                    return {
                        erro: 'Você não possui veículo ativo nesta categoria.',
                        status: 409
                    };
                }

                // Localiza e bloqueia o pagamento da corrida
                const pagamento = await trx('pagamentos_corridas')
                    .where('corrida_id', corridaId)
                    .forUpdate()
                    .first();

                if (!pagamento) {
                    return {
                        erro: 'Pagamento não encontrado para esta corrida.',
                        status: 409
                    };
                }

                // Impede reaplicação da comissão
                if (pagamento.graduacao_id) {
                    return {
                        erro: 'A comissão desta corrida já foi registrada.',
                        status: 409
                    };
                }

                // Só permite aplicar comissão em pagamento pendente
                if (pagamento.status !== 'PENDENTE') {
                    return {
                        erro: 'O pagamento não está pendente e não pode receber comissão.',
                        status: 409
                    };
                }

                // Calcula comissão em centavos para evitar
                // imprecisão de arredondamento com valores decimais.
                const valorBrutoCentavos = Math.round(
                    Number(pagamento.valor_bruto) * 100
                );

                if (
                    !Number.isSafeInteger(valorBrutoCentavos) ||
                    valorBrutoCentavos < 0
                ) {
                    throw new Error(
                        'Valor bruto inválido no pagamento da corrida.'
                    );
                }

                const valorComissaoCentavos = Math.round(
                    valorBrutoCentavos * percentualComissao / 100
                );

                const valorLiquidoCentavos =
                    valorBrutoCentavos - valorComissaoCentavos;

                const valorComissao = (
                    valorComissaoCentavos / 100
                ).toFixed(2);

                const valorLiquido = (
                    valorLiquidoCentavos / 100
                ).toFixed(2);

                // Registra a fotografia da graduação e comissão.
                // O pagamento permanece PENDENTE.
                await trx('pagamentos_corridas')
                    .where('id', pagamento.id)
                    .update({
                        graduacao_id: motorista.graduacao_id,
                        graduacao_nome: motorista.graduacao_nome,

                        percentual_comissao: percentualComissao,
                        valor_comissao: valorComissao,
                        valor_liquido: valorLiquido,

                        updated_at: trx.fn.now()
                    });

                // Atualiza a corrida
                await trx('corridas')
                    .where('id', corridaId)
                    .where('status', 'SOLICITADA')
                    .update({
                        motorista_id: motorista.id,
                        status: 'ACEITA',
                        updated_at: trx.fn.now()
                    });

                // Marca a tentativa como aceita
                await trx('tentativas_corrida')
                    .where('id', tentativa.id)
                    .update({
                        status: 'ACEITA',
                        data_resposta: trx.fn.now(),
                        updated_at: trx.fn.now()
                    });

                // Cancela outras ofertas pendentes desta corrida
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
                    tentativaId: tentativa.id,
                    percentualComissao,
                    valorComissao,
                    valorLiquido
                };
            });

            if (resultado.erro) {
                return response.status(resultado.status).json({
                    error: resultado.erro
                });
            }

            // A corrida já foi aceita no banco.
            // Encerra todos os temporizadores associados a ela.
            limparTemporizadoresCorrida(corridaId);

            console.log('=================================');
            console.log('CORRIDA ACEITA - COMISSÃO REGISTRADA');
            console.log('Corrida:', corridaId);
            console.log('Motorista:', motorista.id);
            console.log('Graduação:', motorista.graduacao_nome);
            console.log('Comissão:', resultado.percentualComissao + '%');
            console.log('Valor comissão:', resultado.valorComissao);
            console.log('Valor líquido:', resultado.valorLiquido);
            console.log('Pagamento continua PENDENTE');
            console.log('=================================');

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
    // MOTORISTA CONFIRMA RECEBIMENTO DO PAGAMENTO PRESENCIAL
    // ==========================================================

    async confirmarPagamento(request, response) {
        try {
            const usuarioId = request.user.id;
            const { id: corridaId } = request.params;

            // Localiza o motorista autenticado
            const motorista = await connection('motoristas')
                .join(
                    'usuarios',
                    'usuarios.id',
                    'motoristas.usuario_id'
                )
                .where('motoristas.usuario_id', usuarioId)
                .where('usuarios.tipo', 'MOTORISTA')
                .where('usuarios.status', 'ATIVO')
                .where('motoristas.status', 'APROVADO')
                .select('motoristas.id')
                .first();

            if (!motorista) {
                return response.status(403).json({
                    error: 'Motorista não encontrado ou não autorizado.'
                });
            }

            const resultado = await connection.transaction(async trx => {

                // Bloqueia a corrida
                const corrida = await trx('corridas')
                    .where('id', corridaId)
                    .forUpdate()
                    .first();

                if (!corrida) {
                    return {
                        erro: 'Corrida não encontrada.',
                        status: 404
                    };
                }

                // Confirma que a corrida pertence ao motorista
                if (corrida.motorista_id !== motorista.id) {
                    return {
                        erro: 'Esta corrida não pertence a você.',
                        status: 403
                    };
                }

                // O pagamento só pode ser confirmado
                // depois da finalização da corrida
                if (corrida.status !== 'FINALIZADA') {
                    return {
                        erro: 'A corrida precisa estar finalizada para confirmar o pagamento.',
                        status: 409
                    };
                }

                // Bloqueia o pagamento
                const pagamento = await trx('pagamentos_corridas')
                    .where('corrida_id', corridaId)
                    .forUpdate()
                    .first();

                if (!pagamento) {
                    return {
                        erro: 'Pagamento não encontrado para esta corrida.',
                        status: 404
                    };
                }

                // Motorista não confirma pagamento online
                if (pagamento.modalidade !== 'PRESENCIAL') {
                    return {
                        erro: 'Pagamentos online devem ser confirmados exclusivamente pelo gateway.',
                        status: 403
                    };
                }

                // Impede confirmação duplicada
                if (pagamento.status !== 'PENDENTE') {
                    return {
                        erro: 'Este pagamento não está pendente ou já foi processado.',
                        status: 409
                    };
                }

                // Confirma o recebimento
                const quantidadeAtualizada = await trx('pagamentos_corridas')
                    .where('id', pagamento.id)
                    .where('status', 'PENDENTE')
                    .update({
                        status: 'APROVADO',
                        confirmado_em: trx.fn.now(),
                        confirmado_por: usuarioId,
                        tipo_confirmacao: 'MOTORISTA',
                        updated_at: trx.fn.now()
                    });

                if (quantidadeAtualizada !== 1) {
                    return {
                        erro: 'Não foi possível confirmar o pagamento.',
                        status: 409
                    };
                }

                const pagamentoAtualizado = await trx('pagamentos_corridas')
                    .where('id', pagamento.id)
                    .first();

                return {
                    pagamento: pagamentoAtualizado
                };
            });

            if (resultado.erro) {
                return response.status(resultado.status).json({
                    error: resultado.erro
                });
            }

            console.log('=================================');
            console.log('PAGAMENTO PRESENCIAL CONFIRMADO');
            console.log('Corrida:', corridaId);
            console.log('Motorista:', motorista.id);
            console.log('Modalidade: PRESENCIAL');
            console.log('Status: APROVADO');
            console.log('=================================');

            return response.json({
                message: 'Pagamento confirmado com sucesso.',
                pagamento: resultado.pagamento
            });

        } catch (error) {
            console.error(
                'Erro ao confirmar pagamento:',
                error
            );

            return response.status(500).json({
                error: 'Erro ao confirmar pagamento.'
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
                    .where('usuario_id', usuarioId)
                    .first();

                if (!motorista) {

                    return response.status(403).json({
                        error: 'Cadastro de motorista não encontrado.'
                    });

                }

                // ==============================================
                // PRIMEIRO: BUSCA CORRIDA EM ANDAMENTO
                // ==============================================

                let corrida = await connection('corridas')
                    .where('motorista_id', motorista.id)
                    .whereIn('status', [
                        'ACEITA',
                        'EM_ANDAMENTO'
                    ])
                    .orderBy('created_at', 'desc')
                    .first();

                // ==============================================
                // SE NÃO EXISTIR, BUSCA CORRIDA FINALIZADA
                // COM PAGAMENTO PENDENTE
                // ==============================================

                if (!corrida) {

                    corrida = await connection('corridas')
                        .join(
                            'pagamentos_corridas',
                            'pagamentos_corridas.corrida_id',
                            'corridas.id'
                        )
                        .where(
                            'corridas.motorista_id',
                            motorista.id
                        )
                        .where(
                            'corridas.status',
                            'FINALIZADA'
                        )
                        .where(
                            'pagamentos_corridas.status',
                            'PENDENTE'
                        )
                        .select('corridas.*')
                        .orderBy(
                            'corridas.created_at',
                            'desc'
                        )
                        .first();

                }

                // ==============================================
                // NENHUMA CORRIDA ATUAL
                // ==============================================

                if (!corrida) {

                    return response.json({
                        corrida: null
                    });

                }

                // ==============================================
                // BUSCA PAGAMENTO DA CORRIDA
                // ==============================================

                const pagamento = await connection('pagamentos_corridas')
                    .where('corrida_id', corrida.id)
                    .select(
                        'id',
                        'corrida_id',
                        'modalidade',
                        'forma_pagamento',
                        'status',
                        'valor_bruto',
                        'percentual_comissao',
                        'graduacao_id',
                        'graduacao_nome',
                        'valor_comissao',
                        'valor_liquido',
                        'gateway',
                        'confirmado_em',
                        'tipo_confirmacao'
                    )
                    .first();

                // ==============================================
                // RESPOSTA PARA MOTORISTA
                // ==============================================

                return response.json({
                    corrida: {
                        ...corrida,
                        pagamento: pagamento || null
                    }
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
                    .where('cliente_id', usuarioId)
                    .whereIn('status', [
                        'SOLICITADA',
                        'ACEITA',
                        'EM_ANDAMENTO'
                    ])
                    .orderBy('created_at', 'desc')
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
                        .where('id', corrida.motorista_id)
                        .first();

                    if (motoristaBanco) {

                        const usuarioMotorista = await connection('usuarios')
                            .where('id', motoristaBanco.usuario_id)
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
                console.log('Motorista ID:', corrida.motorista_id);
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
                error: 'Tipo de usuário não autorizado.'
            });

        } catch (error) {

            console.error(
                'Erro ao buscar minha corrida:',
                error
            );

            return response.status(500).json({
                error: 'Erro ao buscar minha corrida.'
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