
const connection = require('../database/connection');

const crypto = require('crypto');

const MercadoPagoService = require('../services/MercadoPagoService');

require('dotenv/config');

// ==========================================================
// FUNÇÕES AUXILIARES
// ==========================================================

function obterDadosPix(order) {

    const pagamento =
        order?.transactions?.payments?.[0] || {};

    const metodo = pagamento.payment_method || {};

    return {

        qr_code: metodo.qr_code || null,

        qr_code_base64: metodo.qr_code_base64 || null,

        ticket_url: metodo.ticket_url || null,

        gateway_status:
            order.status || pagamento.status || null,

        gateway_status_detail:
            order.status_detail || pagamento.status_detail || null

    };
}

// ==========================================================
// VALIDAR ASSINATURA DO WEBHOOK
// ==========================================================

function validarAssinaturaWebhook(request) {

    const secret = process.env.MP_WEBHOOK_SECRET;

    if (!secret) {
        throw new Error('MP_WEBHOOK_SECRET não configurado.');
    }

    const assinatura = request.headers['x-signature'];

    const requestId = request.headers['x-request-id'];

    const dataId =
        request.query['data.id'] ||
        request.body?.data?.id;

    if (!assinatura || !requestId || !dataId) {
        return false;
    }

    const partes = {};

    assinatura.split(',').forEach(parte => {

        const [chave, valor] = parte.trim().split('=');

        if (chave && valor) {
            partes[chave] = valor;
        }

    });

    const timestamp = partes.ts;
    const assinaturaRecebida = partes.v1;

    if (!timestamp || !assinaturaRecebida) {
        return false;
    }

    const manifesto =
        `id:${String(dataId).toLowerCase()};` +
        `request-id:${requestId};` +
        `ts:${timestamp};`;

    const assinaturaCalculada = crypto
        .createHmac('sha256', secret)
        .update(manifesto)
        .digest('hex');

    const bufferCalculado = Buffer.from(
        assinaturaCalculada,
        'hex'
    );

    const bufferRecebido = Buffer.from(
        assinaturaRecebida,
        'hex'
    );

    if (
        bufferCalculado.length !== bufferRecebido.length
    ) {
        return false;
    }

    return crypto.timingSafeEqual(
        bufferCalculado,
        bufferRecebido
    );
}

// ==========================================================
// COMPARAR VALORES EM CENTAVOS
// ==========================================================

function valoresIguais(valorA, valorB) {

    const centavosA = Math.round(Number(valorA) * 100);

    const centavosB = Math.round(Number(valorB) * 100);

    return (
        Number.isFinite(centavosA) &&
        Number.isFinite(centavosB) &&
        centavosA === centavosB
    );
}

// ==========================================================
// CONTROLLER
// ==========================================================

module.exports = {

    // ======================================================
    // CRIAR PIX
    // ======================================================

    async criarPix(request, response) {

        try {

            const usuarioId = request.user.id;

            const tipoUsuario = request.user.tipo;

            const corridaId = request.params.id;

            if (tipoUsuario !== 'CLIENTE') {

                return response.status(403).json({
                    error: 'Somente clientes podem iniciar este pagamento.'
                });
            }

            if (!corridaId) {

                return response.status(400).json({
                    error: 'Identificador da corrida não informado.'
                });
            }

            // ==================================================
            // LOCALIZAR CORRIDA, PAGAMENTO E CLIENTE
            // ==================================================

            const dados = await connection.transaction(
                async trx => {

                    const corrida = await trx('corridas')
                        .where({
                            id: corridaId,
                            cliente_id: usuarioId
                        })
                        .forUpdate()
                        .first();

                    if (!corrida) {
                        throw new Error(
                            'Corrida não encontrada para este cliente.'
                        );
                    }

                    const pagamento = await trx('pagamentos_corridas')
                        .where('corrida_id', corridaId)
                        .forUpdate()
                        .first();

                    if (!pagamento) {
                        throw new Error(
                            'Pagamento não encontrado para esta corrida.'
                        );
                    }

                    if (
                        pagamento.modalidade !== 'ONLINE' ||
                        pagamento.forma_pagamento !== 'PIX'
                    ) {
                        throw new Error(
                            'Esta corrida não possui pagamento online via PIX.'
                        );
                    }

                    if (pagamento.status !== 'PENDENTE') {
                        throw new Error(
                            'Este pagamento não está pendente.'
                        );
                    }

                    if (
                        pagamento.gateway &&
                        pagamento.gateway !== 'MERCADO_PAGO'
                    ) {
                        throw new Error(
                            'Este pagamento já está vinculado a outro gateway.'
                        );
                    }

                    const usuario = await trx('usuarios')
                        .where('id', usuarioId)
                        .select('email')
                        .first();

                    if (!usuario || !usuario.email) {
                        throw new Error(
                            'E-mail do cliente não encontrado.'
                        );
                    }

                    const valor = Number(pagamento.valor_bruto);

                    if (!Number.isFinite(valor) || valor <= 0) {
                        throw new Error(
                            'Valor do pagamento inválido.'
                        );
                    }

                    return {

                        pagamento,

                        email: usuario.email,

                        valor,

                        chaveIdempotencia:
                            pagamento.chave_idempotencia ||
                            `corrida:${corridaId}`

                    };

                }
            );

            const pagamento = dados.pagamento;

            let order;

            // ==================================================
            // SE JÁ EXISTIR ORDER, REUTILIZAR
            // ==================================================

            if (
                pagamento.gateway_transacao_id &&
                pagamento.gateway === 'MERCADO_PAGO'
            ) {

                order = await MercadoPagoService.consultarOrder(
                    pagamento.gateway_transacao_id
                );

            } else {

                // ==============================================
                // CRIAR NOVA ORDER PIX
                // ==============================================

                order = await MercadoPagoService.criarOrderPix({

                    corridaId,

                    valor: dados.valor,

                    email: dados.email,

                    chaveIdempotencia:
                        dados.chaveIdempotencia

                });

            }

            if (!order.id) {
                throw new Error(
                    'Mercado Pago não retornou o identificador da Order.'
                );
            }

            const pix = obterDadosPix(order);

            // ==================================================
            // ATUALIZAR PAGAMENTO
            // ==================================================

            await connection('pagamentos_corridas')
                .where('id', pagamento.id)
                .where('status', 'PENDENTE')
                .update({

                    gateway: 'MERCADO_PAGO',

                    gateway_transacao_id: order.id,

                    gateway_qr_code: pix.qr_code,

                    gateway_qr_code_base64:
                        pix.qr_code_base64,

                    gateway_ticket_url: pix.ticket_url,

                    gateway_status: pix.gateway_status,

                    gateway_status_detail:
                        pix.gateway_status_detail

                });

            // ==================================================
            // RESPOSTA
            // ==================================================

            const resposta = {

                success: true,

                message: 'Solicitação PIX processada.',

                pagamento: {

                    id: pagamento.id,

                    corrida_id: corridaId,

                    status: pagamento.status,

                    valor: dados.valor,

                    modalidade: pagamento.modalidade,

                    forma_pagamento: pagamento.forma_pagamento,

                    gateway: 'MERCADO_PAGO',

                    gateway_transacao_id: order.id,

                    gateway_status: pix.gateway_status,

                    gateway_status_detail:
                        pix.gateway_status_detail,

                    qr_code: pix.qr_code,

                    qr_code_base64: pix.qr_code_base64,

                    ticket_url: pix.ticket_url

                }

            };

            if (
                !pix.qr_code &&
                !pix.qr_code_base64 &&
                !pix.ticket_url
            ) {

                return response.status(202).json({

                    ...resposta,

                    message:
                        'Order criada. Os dados do PIX ainda estão sendo processados.'

                });
            }

            return response.json(resposta);

        } catch (error) {

            console.error(
                'Erro ao criar pagamento PIX:',
                error
            );

            const mensagens = [
                'Corrida não encontrada para este cliente.',
                'Pagamento não encontrado para esta corrida.',
                'Esta corrida não possui pagamento online via PIX.',
                'Este pagamento não está pendente.',
                'Este pagamento já está vinculado a outro gateway.',
                'E-mail do cliente não encontrado.',
                'Valor do pagamento inválido.'
            ];

            if (mensagens.includes(error.message)) {

                return response.status(400).json({
                    error: error.message
                });
            }

            if (error.message.includes('MP_ACCESS_TOKEN')) {

                return response.status(500).json({
                    error: 'Credenciais do Mercado Pago não configuradas.'
                });
            }

            return response.status(500).json({
                error: 'Erro ao iniciar pagamento PIX.'
            });
        }
    },

    // ======================================================
    // CONSULTAR PAGAMENTO
    // ======================================================

    async consultar(request, response) {

        try {

            const usuarioId = request.user.id;

            const corridaId = request.params.id;

            if (request.user.tipo !== 'CLIENTE') {

                return response.status(403).json({
                    error: 'Acesso permitido somente ao cliente.'
                });
            }

            const corrida = await connection('corridas')
                .where({
                    id: corridaId,
                    cliente_id: usuarioId
                })
                .first();

            if (!corrida) {

                return response.status(404).json({
                    error: 'Corrida não encontrada.'
                });
            }

            const pagamento = await connection('pagamentos_corridas')
                .where('corrida_id', corridaId)
                .first();

            if (!pagamento) {

                return response.status(404).json({
                    error: 'Pagamento não encontrado.'
                });
            }

            return response.json({

                success: true,

                pagamento: {

                    id: pagamento.id,

                    corrida_id: pagamento.corrida_id,

                    modalidade: pagamento.modalidade,

                    forma_pagamento: pagamento.forma_pagamento,

                    status: pagamento.status,

                    valor_bruto: pagamento.valor_bruto,

                    percentual_comissao:
                        pagamento.percentual_comissao,

                    valor_comissao: pagamento.valor_comissao,

                    valor_liquido: pagamento.valor_liquido,

                    gateway: pagamento.gateway,

                    gateway_transacao_id:
                        pagamento.gateway_transacao_id,

                    gateway_status: pagamento.gateway_status,

                    gateway_status_detail:
                        pagamento.gateway_status_detail,

                    gateway_qr_code: pagamento.gateway_qr_code,

                    gateway_qr_code_base64:
                        pagamento.gateway_qr_code_base64,

                    gateway_ticket_url:
                        pagamento.gateway_ticket_url,

                    confirmado_em: pagamento.confirmado_em,

                    tipo_confirmacao: pagamento.tipo_confirmacao

                }

            });

        } catch (error) {

            console.error(
                'Erro ao consultar pagamento:',
                error
            );

            return response.status(500).json({
                error: 'Erro ao consultar pagamento.'
            });
        }
    },

    // ======================================================
    // WEBHOOK MERCADO PAGO
    // ======================================================

    async webhook(request, response) {

        try {

            // ==================================================
            // VALIDAR ASSINATURA
            // ==================================================

            const assinaturaValida =
                validarAssinaturaWebhook(request);

            if (!assinaturaValida) {

                console.error(
                    'Webhook Mercado Pago com assinatura inválida.'
                );

                return response.status(401).json({
                    error: 'Assinatura inválida.'
                });
            }

            // ==================================================
            // VALIDAR TIPO DE EVENTO
            // ==================================================

            if (request.body?.type !== 'order') {

                return response.status(200).json({
                    received: true,
                    message: 'Evento ignorado.'
                });
            }

            const orderId =
                request.query['data.id'] ||
                request.body?.data?.id;

            if (!orderId) {

                return response.status(400).json({
                    error: 'Identificador da Order não informado.'
                });
            }

            // ==================================================
            // CONSULTAR ORDER DIRETAMENTE NO MERCADO PAGO
            // ==================================================

            const order =
                await MercadoPagoService.consultarOrder(orderId);

            if (!order || !order.id) {

                return response.status(404).json({
                    error: 'Order não encontrada no Mercado Pago.'
                });
            }

            const corridaId = order.external_reference;

            if (!corridaId) {

                return response.status(200).json({
                    received: true,
                    message: 'Order sem referência externa.'
                });
            }

            // ==================================================
            // LOCALIZAR PAGAMENTO
            // ==================================================

            await connection.transaction(async trx => {

                const pagamento = await trx('pagamentos_corridas')
                    .where('corrida_id', corridaId)
                    .where('modalidade', 'ONLINE')
                    .where('forma_pagamento', 'PIX')
                    .forUpdate()
                    .first();

                if (!pagamento) {

                    console.warn(
                        'Pagamento local não encontrado:',
                        corridaId
                    );

                    return;
                }

                // Se já existe outro pedido associado,
                // não permitir que este webhook altere o pagamento.

                if (
                    pagamento.gateway_transacao_id &&
                    pagamento.gateway_transacao_id !== order.id
                ) {

                    console.warn(
                        'Order diferente da registrada no pagamento:',
                        order.id
                    );

                    return;
                }

                // ==================================================
                // CONFERIR VALOR DA ORDER
                // ==================================================

                if (
                    !valoresIguais(
                        order.total_amount,
                        pagamento.valor_bruto
                    )
                ) {

                    console.error(
                        'Valor da Order diferente do pagamento local.',
                        {
                            orderId: order.id,
                            valorMercadoPago: order.total_amount,
                            valorBanco: pagamento.valor_bruto
                        }
                    );

                    return;
                }

                const pix = obterDadosPix(order);

                // ==================================================
                // ATUALIZAR DADOS DO GATEWAY
                // ==================================================

                const atualizacao = {

                    gateway: 'MERCADO_PAGO',

                    gateway_transacao_id: order.id,

                    gateway_status: pix.gateway_status,

                    gateway_status_detail:
                        pix.gateway_status_detail,

                    gateway_qr_code: pix.qr_code,

                    gateway_qr_code_base64:
                        pix.qr_code_base64,

                    gateway_ticket_url: pix.ticket_url

                };

                // ==================================================
                // CONFIRMAR SOMENTE SE ESTIVER APROVADO
                // ==================================================

                if (
                    order.status === 'processed' &&
                    order.status_detail === 'accredited'
                ) {

                    if (pagamento.status === 'PENDENTE') {

                        atualizacao.status = 'APROVADO';

                        atualizacao.confirmado_em =
                            trx.fn.now();

                        atualizacao.confirmado_por = null;

                        atualizacao.tipo_confirmacao = 'GATEWAY';

                    }

                }

                await trx('pagamentos_corridas')
                    .where('id', pagamento.id)
                    .whereNot('status', 'APROVADO')
                    .update(atualizacao);

            });

            return response.status(200).json({

                received: true,

                message: 'Webhook processado com sucesso.'

            });

        } catch (error) {

            console.error(
                'Erro no webhook Mercado Pago:',
                error
            );

            // Retorno 500 permite que o Mercado Pago tente
            // entregar a notificação novamente.

            return response.status(500).json({
                error: 'Erro ao processar webhook.'
            });
        }
    }

};
