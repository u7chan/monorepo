import pandas


def main():
    print("Hello from python-uv!")

    data = pandas.read_csv("./hello.csv", index_col=False)
    print(data)


if __name__ == "__main__":
    main()
