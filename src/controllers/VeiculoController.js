const connection = require('../database/connection');

module.exports = {

    async marcas(request, response) {

        try {

            const marcas = await connection('marcas')
                .where('ativo', 1)
                .select(
                    'idMarca',
                    'nome'
                )
                .orderBy('nome', 'asc');

            return response.json(marcas);

        } catch (error) {

            console.error('Erro ao buscar marcas:', error);

            return response.status(500).json({
                error: 'Erro ao buscar marcas.'
            });
        }
    },


    async modelosPorMarca(request, response) {

        try {

            const { marcaId } = request.params;

            const modelos = await connection('modelos')
                .where('marca_id', marcaId)
                .where('ativo', 1)
                .select(
                    'idModelo',
                    'nome'
                )
                .orderBy('nome', 'asc');

            return response.json(modelos);

        } catch (error) {

            console.error('Erro ao buscar modelos:', error);

            return response.status(500).json({
                error: 'Erro ao buscar modelos.'
            });
        }
    },

    async categorias(request, response) {

        try {

            const categorias = await connection('categorias')
                .where('ativo', 1)
                .select(
                    'id',
                    'nome',
                    'descricao',
                    'capacidade_passageiros'
                )
                .orderBy('nome', 'asc');

            return response.json(categorias);

        } catch (error) {

            console.error(
                'Erro ao buscar categorias:',
                error
            );

            return response.status(500).json({
                error: 'Erro ao buscar categorias.'
            });
        }
    },

};