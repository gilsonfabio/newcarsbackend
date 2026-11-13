
const API_URL = 'https://api.mercadopago.com';

require('dotenv/config');

// ==========================================================
// REQUISIÇÃO AO MERCADO PAGO
// ==========================================================

async function requisicaoMercadoPago(endpoint, options = {}) {

    const accessToken = process.env.MP_ACCESS_TOKEN;

    if (!accessToken) {
        throw new Error('MP_ACCESS_TOKEN não configurado no servidor.');
    }

    const response = await fetch(`${API_URL}${endpoint}`, {

        ...options,

        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
            ...(options.headers || {})
        }

    });

    const texto = await response.text();

    let dados = {};

    try {
        dados = texto ? JSON.parse(texto) : {};
    } catch (error) {
        dados = { mensagem: texto };
    }

    if (!response.ok) {

        console.error(
            'Erro Mercado Pago:',
            response.status,
            dados
        );

        const error = new Error(
            dados.message ||
            dados.error ||
            'Erro na comunicação com o Mercado Pago.'
        );

        error.status = response.status;
        error.dados = dados;

        throw error;
    }

    return dados;
}

// ==========================================================
// CRIAR ORDER PIX
// ==========================================================

async function criarOrderPix({
    corridaId,
    valor,
    email,
    chaveIdempotencia
}) {

    const valorFormatado = Number(valor).toFixed(2);

    const body = {

        type: 'online',

        total_amount: valorFormatado,

        external_reference: corridaId,

        processing_mode: 'automatic',

        transactions: {

            payments: [

                {
                    amount: valorFormatado,

                    payment_method: {
                        id: 'pix',
                        type: 'bank_transfer'
                    }
                }

            ]

        },

        payer: {
            email,
            first_name: 'APRO'
        }

    };

    return requisicaoMercadoPago('/v1/orders', {

        method: 'POST',

        headers: {
            'X-Idempotency-Key': chaveIdempotencia
        },

        body: JSON.stringify(body)

    });
}

// ==========================================================
// CONSULTAR ORDER
// ==========================================================

async function consultarOrder(orderId) {

    return requisicaoMercadoPago(
        `/v1/orders/${encodeURIComponent(orderId)}`,
        {
            method: 'GET'
        }
    );
}

module.exports = {
    criarOrderPix,
    consultarOrder
};
