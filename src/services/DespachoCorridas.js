
const connection = require('../database/connection');
const { randomUUID } = require('crypto');
const { obterIO } = require('../socket');

const TEMPO_OFERTA_SEGUNDOS = 15;
const temporizadores = new Map();
const tentativasPorCorrida = new Map();

// ==========================================================
// DISTÂNCIA EM LINHA RETA ENTRE DUAS COORDENADAS
// ==========================================================

function calcularDistanciaMetros(lat1, lon1, lat2, lon2) {
    const radianos = valor => valor * Math.PI / 180;
    const raioTerra = 6371000;

    const dLat = radianos(Number(lat2) - Number(lat1));
    const dLon = radianos(Number(lon2) - Number(lon1));

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(radianos(Number(lat1))) *
        Math.cos(radianos(Number(lat2))) *
        Math.sin(dLon / 2) ** 2;

    return raioTerra * 2 * Math.atan2(
        Math.sqrt(a),
        Math.sqrt(1 - a)
    );
}

// ==========================================================
// CRIA OU REATIVA O TEMPORIZADOR DE UMA OFERTA
// ==========================================================


function removerTemporizador(tentativaId, corridaId) {
    const chave = String(tentativaId);
    const temporizador = temporizadores.get(chave);

    if (temporizador) {
        clearTimeout(temporizador);
        temporizadores.delete(chave);
    }

    const tentativas = tentativasPorCorrida.get(String(corridaId));

    if (tentativas) {
        tentativas.delete(chave);

        if (tentativas.size === 0) {
            tentativasPorCorrida.delete(String(corridaId));
        }
    }
}

function limparTemporizadoresCorrida(corridaId) {
    const chaveCorrida = String(corridaId);
    const tentativas = tentativasPorCorrida.get(chaveCorrida);

    if (!tentativas) {
        return;
    }

    for (const tentativaId of tentativas) {
        const temporizador = temporizadores.get(tentativaId);

        if (temporizador) {
            clearTimeout(temporizador);
            temporizadores.delete(tentativaId);
        }
    }

    tentativasPorCorrida.delete(chaveCorrida);
}

function programarExpiracao(corridaId, tentativaId, dataExpiracao) {
    removerTemporizador(tentativaId, corridaId);

    const chaveTentativa = String(tentativaId);
    const chaveCorrida = String(corridaId);

    if (!tentativasPorCorrida.has(chaveCorrida)) {
        tentativasPorCorrida.set(chaveCorrida, new Set());
    }

    tentativasPorCorrida.get(chaveCorrida).add(chaveTentativa);

    const restante = Math.max(
        0,
        new Date(dataExpiracao).getTime() - Date.now()
    );

    const temporizador = setTimeout(async () => {
        removerTemporizador(tentativaId, corridaId);

        try {
            const quantidade = await connection('tentativas_corrida')
                .where('id', tentativaId)
                .where('status', 'PENDENTE')
                .where('data_expiracao', '<=', connection.fn.now())
                .update({
                    status: 'EXPIRADA',
                    data_resposta: connection.fn.now(),
                    updated_at: connection.fn.now()
                });

            if (quantidade > 0) {
                const clienteId = await obterClienteId(corridaId);

                if (clienteId) {
                    obterIO()
                        .to(`usuario:${clienteId}`)
                        .emit('corrida:oferta_expirada', {
                            corrida_id: corridaId,
                            tentativa_id: tentativaId
                        });
                }

                await despacharProximoMotorista(corridaId);
            }
        } catch (error) {
            console.error('Erro ao expirar oferta:', error);
        }
    }, restante);

    temporizadores.set(chaveTentativa, temporizador);
}

// ==========================================================
// SELECIONA O PRÓXIMO MOTORISTA E ENVIA A OFERTA
// ==========================================================

async function despacharProximoMotorista(corridaId) {
    try {
        const resultado = await connection.transaction(async trx => {
            const corrida = await trx('corridas')
                .where('id', corridaId)
                .forUpdate()
                .first();

            if (!corrida || corrida.status !== 'SOLICITADA') {
                return { tipo: 'ENCERRADA' };
            }

            // Se já existe oferta válida, não cria outra simultaneamente.
            const ofertaPendente = await trx('tentativas_corrida')
                .where('corrida_id', corridaId)
                .where('status', 'PENDENTE')
                .where('data_expiracao', '>', trx.fn.now())
                .first();

            if (ofertaPendente) {
                return {
                    tipo: 'PENDENTE',
                    tentativa: ofertaPendente
                };
            }

            // Expira qualquer tentativa que tenha vencido.
            await trx('tentativas_corrida')
                .where('corrida_id', corridaId)
                .where('status', 'PENDENTE')
                .where('data_expiracao', '<=', trx.fn.now())
                .update({
                    status: 'EXPIRADA',
                    data_resposta: trx.fn.now(),
                    updated_at: trx.fn.now()
                });

            // Busca motoristas aprovados, online e com veículo
            // ativo exatamente na categoria solicitada.
            const motoristas = await trx('motoristas')
                .join(
                    'usuarios',
                    'usuarios.id',
                    'motoristas.usuario_id'
                )
                .join(
                    'veiculos',
                    'veiculos.motorista_id',
                    'motoristas.id'
                )
                .where('motoristas.status', 'APROVADO')
                .where('motoristas.online', 1)
                .where('usuarios.tipo', 'MOTORISTA')
                .where('usuarios.status', 'ATIVO')
                .where('veiculos.ativo', 1)
                .where('veiculos.categoria_id', corrida.categoria_veiculo_id)
                .whereNotNull('motoristas.latitude')
                .whereNotNull('motoristas.longitude')
                .whereNotExists(function () {
                    this.select('*')
                        .from('corridas as c')
                        .whereRaw('c.motorista_id = motoristas.id')
                        .whereIn('c.status', ['ACEITA', 'EM_ANDAMENTO']);
                })
                .whereNotExists(function () {
                    this.select('*')
                        .from('tentativas_corrida as tc')
                        .whereRaw('tc.motorista_id = motoristas.id')
                        .where('tc.corrida_id', corridaId);
                })
                .select(
                    'motoristas.id',
                    'motoristas.usuario_id',
                    'motoristas.latitude',
                    'motoristas.longitude'
                )
                .groupBy(
                    'motoristas.id',
                    'motoristas.usuario_id',
                    'motoristas.latitude',
                    'motoristas.longitude'
                );

            if (!motoristas.length) {
                return {
                    tipo: 'SEM_MOTORISTA',
                    corrida
                };
            }

            // Ordena por distância em linha reta até o embarque.
            // A Google Routes API continua sendo usada para o preço
            // e para a rota da corrida.
            motoristas.sort((a, b) => {
                const distanciaA = calcularDistanciaMetros(
                    corrida.origem_latitude,
                    corrida.origem_longitude,
                    a.latitude,
                    a.longitude
                );

                const distanciaB = calcularDistanciaMetros(
                    corrida.origem_latitude,
                    corrida.origem_longitude,
                    b.latitude,
                    b.longitude
                );

                return distanciaA - distanciaB;
            });

            const motorista = motoristas[0];
            const tentativaId = randomUUID();
            const dataExpiracao = new Date(
                Date.now() + TEMPO_OFERTA_SEGUNDOS * 1000
            );

            await trx('tentativas_corrida').insert({
                id: tentativaId,
                corrida_id: corridaId,
                motorista_id: motorista.id,
                status: 'PENDENTE',
                data_envio: trx.fn.now(),
                data_expiracao: dataExpiracao
            });

            return {
                tipo: 'OFERTA',
                corrida,
                motorista,
                tentativa: {
                    id: tentativaId,
                    corrida_id: corridaId,
                    motorista_id: motorista.id,
                    data_expiracao: dataExpiracao
                }
            };
        });

        const io = obterIO();

        if (resultado.tipo === 'OFERTA') {
            io.to(`usuario:${resultado.motorista.usuario_id}`)
                .emit('corrida:nova_oferta', {
                    tentativa_id: resultado.tentativa.id,
                    data_expiracao: resultado.tentativa.data_expiracao,
                    corrida: resultado.corrida
                });

            io.to(`usuario:${resultado.corrida.cliente_id}`)
                .emit('corrida:buscando_motorista', {
                    corrida_id: corridaId,
                    mensagem: 'Estamos procurando um motorista.'
                });

            programarExpiracao(
                corridaId,
                resultado.tentativa.id,
                resultado.tentativa.data_expiracao
            );
        } else if (resultado.tipo === 'PENDENTE') {
            programarExpiracao(
                corridaId,
                resultado.tentativa.id,
                resultado.tentativa.data_expiracao
            );
        } else if (resultado.tipo === 'SEM_MOTORISTA') {
            io.to(`usuario:${resultado.corrida.cliente_id}`)
                .emit('corrida:sem_motorista', {
                    corrida_id: corridaId,
                    mensagem: 'Não encontramos motoristas disponíveis neste momento.'
                });
        }

        return resultado;
    } catch (error) {
        console.error('Erro no despacho da corrida:', error);
        throw error;
    }
}

// ==========================================================
// MOTORISTA RECUSA UMA OFERTA
// ==========================================================

async function recusarOferta(corridaId, motoristaId) {
    const tentativa = await connection('tentativas_corrida')
        .where('corrida_id', corridaId)
        .where('motorista_id', motoristaId)
        .where('status', 'PENDENTE')
        .where('data_expiracao', '>', connection.fn.now())
        .first();

    if (!tentativa) {
        return false;
    }

    const quantidade = await connection('tentativas_corrida')
        .where('id', tentativa.id)
        .where('status', 'PENDENTE')
        .update({
            status: 'RECUSADA',
            data_resposta: connection.fn.now(),
            updated_at: connection.fn.now()
        });

    if (!quantidade) {
        return false;
    }

    removerTemporizador(tentativa.id, corridaId);

    await despacharProximoMotorista(corridaId);

    return true;
}

// ==========================================================
// RECUPERA OFERTAS APÓS REINICIALIZAÇÃO DO BACKEND
// ==========================================================

async function recuperarDespachos() {
    try {
        // Corridas com oferta ainda pendente.
        const pendentes = await connection('tentativas_corrida')
            .join(
                'corridas',
                'corridas.id',
                'tentativas_corrida.corrida_id'
            )
            .where('tentativas_corrida.status', 'PENDENTE')
            .where('corridas.status', 'SOLICITADA')
            .select(
                'tentativas_corrida.id as tentativa_id',
                'tentativas_corrida.corrida_id',
                'tentativas_corrida.data_expiracao'
            );

        for (const tentativa of pendentes) {
            if (new Date(tentativa.data_expiracao).getTime() <= Date.now()) {
                await connection('tentativas_corrida')
                    .where('id', tentativa.tentativa_id)
                    .where('status', 'PENDENTE')
                    .update({
                        status: 'EXPIRADA',
                        data_resposta: connection.fn.now(),
                        updated_at: connection.fn.now()
                    });

                await despacharProximoMotorista(tentativa.corrida_id);
            } else {
                programarExpiracao(
                    tentativa.corrida_id,
                    tentativa.tentativa_id,
                    tentativa.data_expiracao
                );
            }
        }

        // Corridas ainda solicitadas sem qualquer oferta pendente.
        const solicitadas = await connection('corridas')
            .where('status', 'SOLICITADA')
            .select('id');

        for (const corrida of solicitadas) {
            await despacharProximoMotorista(corrida.id);
        }

        console.log('Recuperação dos despachos concluída.');
    } catch (error) {
        console.error('Erro ao recuperar despachos:', error);
    }
}

module.exports = {
    despacharProximoMotorista,
    recusarOferta,
    recuperarDespachos,
    limparTemporizadoresCorrida
};