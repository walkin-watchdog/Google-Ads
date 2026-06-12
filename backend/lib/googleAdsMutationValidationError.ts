export class GoogleAdsMutationValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GoogleAdsMutationValidationError';
    }
}
