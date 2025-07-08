# k8s.d

TypeScript definitions for Kubernetes manifests with full type safety and autocompletion support.

## Installation

```bash
npm install k8s.d
# or
yarn add k8s.d
```

## Usage

`k8s.d` provides TypeScript types for all Kubernetes resources, allowing you to define your Kubernetes manifests with full type safety and IDE autocompletion.

### Example

```typescript
import {Service} from 'k8s.d/core/v1'

export const myService: Service = {
  apiVersion: 'v1',
  kind: 'Service',
  metadata: {
    name: 'my-service',
  },
  spec: {
    selector: {
      app: 'my-app',
    },
  },
}
```

### Benefits

- Full TypeScript support with type checking
- IDE autocompletion for all Kubernetes resource fields
- Catch configuration errors at compile time
- Better maintainability and documentation through types

### Available Resources

The package includes TypeScript definitions for all Kubernetes resources, organized by API groups:

- `core/v1`: Core resources like Pod, Service, ConfigMap, etc.
- `apps/v1`: Deployment, StatefulSet, DaemonSet, etc.
- `networking.k8s.io/v1`: Ingress, NetworkPolicy, etc.
- And many more...

## Development

To build the project:

```bash
npm install
npm run build
```

## License

MIT License
