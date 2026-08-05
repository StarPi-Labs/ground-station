# Backend API

A RESTful API for managing and interacting with the rocket's mcu.

## Prerequisites

* Docker >= 29.*: for running the backend.
* BlueZ >= 5.55: for Bluetooth communication with the mcu.

## Getting Started

1. Clone the repository:
    ```sh
    git clone https://github.com/StarPi-Labs/ground-station.git
    cd ground-station/backend
    ```

2. Build the Docker image:
    ```sh
    docker build -t StarPi/gs-backend .
    ```

3. Run the Docker container:
    ```sh
    docker compose up
    ```

    > [!NOTE]
    >
    > If you want to run it interactively, you can use:
    > ```sh
    > docker compose run --rm -it backend
    > ```
