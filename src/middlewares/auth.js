const jwt = require('jsonwebtoken');

require('dotenv/config');

module.exports = function auth(request, response, next) {

    const authHeader = request.headers.authorization;

    if (!authHeader) {

        return response.status(401).json({
            error: 'Token não informado.'
        });

    }

    const parts = authHeader.split(' ');

    if (parts.length !== 2) {

        return response.status(401).json({
            error: 'Token inválido.'
        });

    }

    const [scheme, token] = parts;

    if (scheme !== 'Bearer') {

        return response.status(401).json({
            error: 'Token inválido.'
        });

    }

    try {

        const decoded = jwt.verify(
            token,
            process.env.SECRET_JWT
        );

        request.user = decoded;

        next();

    } catch (error) {

        return response.status(401).json({
            error: 'Token inválido ou expirado.'
        });

    }
};